/**
 * Tests for full-text conversation search, against temporary transcript files.
 * Run with: npm test
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ContentIndex, extractMessages, makeSnippet, parseQuery } from '../src/data/contentSearch';

let failures = 0;
function check(name: string, cond: boolean, extra?: string): void {
  if (!cond) {
    failures++;
  }
  console.log(`  ${cond ? '✓' : '✗'} ${name}${extra ? '  — ' + extra : ''}`);
}

const rec = (type: string, content: unknown): string => JSON.stringify({ type, message: { content } });

async function main(): Promise<void> {
  console.log('contentSearch helpers');
  check('parseQuery lowercases and splits', JSON.stringify(parseQuery('  Auth  RETRY ')) === '["auth","retry"]');
  check('parseQuery empty', parseQuery('   ').length === 0);
  check('snippet short text passthrough', makeSnippet('fix the auth bug', 'auth') === 'fix the auth bug');
  const long = 'word '.repeat(40) + 'NEEDLE here ' + 'tail '.repeat(40);
  const snip = makeSnippet(long, 'needle');
  check('snippet contains the match', snip.includes('NEEDLE'), snip);
  check('snippet is elided on both sides', snip.startsWith('…') && snip.endsWith('…'));
  check('snippet stays short', snip.length < 160, String(snip.length));
  check('snippet collapses newlines', !makeSnippet('a\n\nb auth', 'auth').includes('\n'));

  const msgs = extractMessages(
    [
      rec('user', 'How do I add retry logic to the auth client?'),
      rec('assistant', [
        { type: 'thinking', thinking: 'secret reasoning about zebras' },
        { type: 'text', text: 'Wrap the call in exponential backoff.' },
        { type: 'tool_use', name: 'Edit', input: { file: 'zebra.ts' } },
      ]),
      rec('user', [{ type: 'tool_result', content: 'zebra tool output' }]),
      JSON.stringify({ type: 'summary', summary: 'zebra summary' }),
      'not json',
      '',
    ].join('\n'),
  );
  check('extracts user + assistant text only', msgs.length === 2, String(msgs.length));
  check('skips thinking, tool calls and tool results', !msgs.some((m) => m.lower.includes('zebra')));

  console.log('\nContentIndex against temp transcripts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-search-'));
  try {
    const a = path.join(dir, 'a.jsonl');
    const b = path.join(dir, 'b.jsonl');
    fs.writeFileSync(
      a,
      [
        rec('user', 'Please retry the auth request on 503'),
        rec('assistant', [{ type: 'text', text: 'Added auth retry with backoff.' }]),
      ].join('\n'),
    );
    fs.writeFileSync(b, [rec('user', 'Rename the CSS variables'), rec('assistant', 'Done, auth untouched.')].join('\n'));
    const docs = [
      { id: 'a', filePath: a },
      { id: 'b', filePath: b },
      { id: 'missing', filePath: path.join(dir, 'gone.jsonl') },
    ];
    const index = new ContentIndex();
    await index.warm(docs);

    const hits = await index.search(docs, 'AUTH retry');
    check('terms may appear apart, case-insensitive', hits.length === 1 && hits[0].id === 'a');
    check('counts every matching message', hits[0]?.matches === 2, String(hits[0]?.matches));
    check('reports the first match role', hits[0]?.role === 'user');

    const auth = await index.search(docs, 'auth');
    check('matches across sessions in doc order', auth.map((h) => h.id).join(',') === 'a,b');
    check('assistant string content is searchable', auth[1]?.role === 'assistant');
    check('empty query returns nothing', (await index.search(docs, '  ')).length === 0);
    check('no match returns nothing', (await index.search(docs, 'kubernetes')).length === 0);
    check('cancelled search returns nothing', (await index.search(docs, 'auth', () => true)).length === 0);

    // Edit a transcript: the cache must notice the change (size differs).
    fs.appendFileSync(b, '\n' + rec('user', 'now add kubernetes manifests'));
    const k = await index.search(docs, 'kubernetes');
    check('re-reads a changed transcript', k.length === 1 && k[0].id === 'b');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failed check(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
