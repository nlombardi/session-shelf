/**
 * Tests for transcript parsing: whether Claude is mid-turn in a session.
 * Run with: npm test
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseSession } from '../src/data/transcript';

let failures = 0;
function check(name: string, cond: boolean, extra?: string): void {
  if (!cond) {
    failures++;
  }
  console.log(`  ${cond ? '✓' : '✗'} ${name}${extra ? '  — ' + extra : ''}`);
}

const T0 = '2026-11-14T03:00:00.000Z';
const T1 = '2026-11-14T03:00:05.000Z';
const user = (content: unknown, extra: object = {}): object => ({ type: 'user', timestamp: T0, message: { content }, ...extra });
const asst = (stop: string | null, content: unknown = [{ type: 'text', text: 'ok' }]): object => ({
  type: 'assistant',
  timestamp: T1,
  message: { content, stop_reason: stop },
});
const bookkeeping = [{ type: 'cost-state' }, { type: 'mode', mode: 'default' }, { type: 'last-prompt', lastPrompt: 'x' }];

async function parse(dir: string, name: string, records: object[]) {
  const fp = path.join(dir, name + '.jsonl');
  const text = records.map((r) => JSON.stringify(r)).join('\n');
  fs.writeFileSync(fp, text);
  const meta = await parseSession(fp, Buffer.byteLength(text), Date.now());
  if (!meta) {
    throw new Error('parseSession returned null for ' + name);
  }
  return meta;
}

async function main(): Promise<void> {
  console.log('transcript: mid-turn detection');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-transcript-'));
  try {
    const done = await parse(dir, 'done', [user('hi'), asst('end_turn'), ...bookkeeping]);
    check('finished turn followed by bookkeeping is idle', !done.midTurn);
    check('records the last message time', done.lastTurnMs === Date.parse(T1), String(done.lastTurnMs));

    check('unanswered prompt is mid-turn', (await parse(dir, 'prompt', [asst('end_turn'), user('next')])).midTurn);
    check(
      'tool call in progress is mid-turn',
      (await parse(dir, 'tool', [user('go'), asst('tool_use', [{ type: 'tool_use', name: 'Bash' }])])).midTurn,
    );
    check(
      'unanswered tool result is mid-turn',
      (await parse(dir, 'result', [asst('tool_use'), user([{ type: 'tool_result', content: 'x' }])])).midTurn,
    );
    check('streaming block (no stop reason) is mid-turn', (await parse(dir, 'stream', [user('go'), asst(null)])).midTurn);
    check(
      'interrupted turn is idle',
      !(await parse(dir, 'interrupt', [user('go'), asst('tool_use'), user([{ type: 'text', text: '[Request interrupted by user]' }])]))
        .midTurn,
    );
    check(
      'slash-command output does not start a turn',
      !(await parse(dir, 'slash', [asst('end_turn'), user('<command-name>/model</command-name>'), user('<local-command-stdout>ok</local-command-stdout>')]))
        .midTurn,
    );
    check(
      'injected meta records do not start a turn',
      !(await parse(dir, 'meta', [asst('end_turn'), user('<system-reminder>x</system-reminder>', { isMeta: true })])).midTurn,
    );
    const ask = await parse(dir, 'ask', [user('plan it'), asst('tool_use', [{ type: 'tool_use', name: 'AskUserQuestion' }])]);
    check('a pending question is mid-turn but flagged pendingAsk', ask.midTurn && ask.pendingAsk);
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
