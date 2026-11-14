import * as fs from 'fs/promises';
import { extractText } from './transcript';

/** A searchable session transcript. */
export interface SearchDoc {
  id: string;
  filePath: string;
}

export type MessageRole = 'user' | 'assistant';

/** One session whose conversation matches the query. */
export interface ContentHit {
  id: string;
  /** Number of messages in the session that match. */
  matches: number;
  /** Who wrote the first matching message. */
  role: MessageRole;
  /** A single-line excerpt around the first match. */
  snippet: string;
}

interface Message {
  role: MessageRole;
  text: string;
  lower: string;
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  messages: Message[];
}

/** Split a query into lowercase terms. Every term must appear in the same message. */
export function parseQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/**
 * A one-line excerpt of `text` around the first occurrence of `term`, with
 * ellipses where it was cut. Falls back to the start of the text.
 */
export function makeSnippet(text: string, term: string, before = 40, after = 100): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const at = term ? flat.toLowerCase().indexOf(term) : -1;
  if (at < 0) {
    return flat.length > before + after ? flat.slice(0, before + after) + '…' : flat;
  }
  let start = Math.max(0, at - before);
  let end = Math.min(flat.length, at + term.length + after);
  // Prefer to cut on word boundaries.
  if (start > 0) {
    const sp = flat.indexOf(' ', start);
    if (sp !== -1 && sp < at) {
      start = sp + 1;
    }
  }
  if (end < flat.length) {
    const sp = flat.lastIndexOf(' ', end);
    if (sp > at + term.length) {
      end = sp;
    }
  }
  return (start > 0 ? '…' : '') + flat.slice(start, end) + (end < flat.length ? '…' : '');
}

/** Extract the human-visible messages (your prompts and Claude's replies) from a transcript. */
export function extractMessages(jsonl: string): Message[] {
  const out: Message[] = [];
  for (const line of jsonl.split('\n')) {
    const s = line.trim();
    if (!s) {
      continue;
    }
    let r: { type?: unknown; isSidechain?: unknown; message?: { content?: unknown } };
    try {
      r = JSON.parse(s);
    } catch {
      continue;
    }
    if (!r || typeof r !== 'object' || (r.type !== 'user' && r.type !== 'assistant')) {
      continue;
    }
    // Tool results arrive as user records with no text blocks, so extractText skips them.
    const text = extractText(r.message?.content);
    if (text) {
      out.push({ role: r.type, text, lower: text.toLowerCase() });
    }
  }
  return out;
}

/**
 * Full-text search over session transcripts. Extracted message text is cached by
 * (mtime, size), so after the first search only changed transcripts are re-read.
 */
export class ContentIndex {
  private cache = new Map<string, CacheEntry>();

  /** Read every transcript into the cache ahead of the first query. */
  async warm(docs: SearchDoc[], isCancelled?: () => boolean): Promise<void> {
    for (const d of docs) {
      if (isCancelled?.()) {
        return;
      }
      await this.messagesOf(d.filePath);
    }
    this.prune(docs);
  }

  /**
   * Sessions with at least one message containing every query term, in the order
   * of `docs`. Returns [] for an empty query or when cancelled part-way.
   */
  async search(docs: SearchDoc[], query: string, isCancelled?: () => boolean): Promise<ContentHit[]> {
    const terms = parseQuery(query);
    if (!terms.length) {
      return [];
    }
    const hits: ContentHit[] = [];
    for (const d of docs) {
      if (isCancelled?.()) {
        return [];
      }
      const messages = await this.messagesOf(d.filePath);
      let first: Message | undefined;
      let matches = 0;
      for (const m of messages) {
        if (terms.every((t) => m.lower.includes(t))) {
          matches++;
          first ??= m;
        }
      }
      if (first) {
        hits.push({ id: d.id, matches, role: first.role, snippet: makeSnippet(first.text, terms[0]) });
      }
    }
    return hits;
  }

  /** Reads in progress, so the background warm-up and a query never read a file twice. */
  private inflight = new Map<string, Promise<Message[]>>();

  private messagesOf(filePath: string): Promise<Message[]> {
    let p = this.inflight.get(filePath);
    if (!p) {
      p = this.load(filePath).finally(() => this.inflight.delete(filePath));
      this.inflight.set(filePath, p);
    }
    return p;
  }

  private async load(filePath: string): Promise<Message[]> {
    try {
      const st = await fs.stat(filePath);
      const cached = this.cache.get(filePath);
      if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
        return cached.messages;
      }
      const messages = extractMessages(await fs.readFile(filePath, 'utf8'));
      this.cache.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, messages });
      return messages;
    } catch {
      return []; // unreadable or deleted transcript
    }
  }

  /** Drop cached transcripts that are no longer in the session list. */
  private prune(docs: SearchDoc[]): void {
    const keep = new Set(docs.map((d) => d.filePath));
    for (const fp of this.cache.keys()) {
      if (!keep.has(fp)) {
        this.cache.delete(fp);
      }
    }
  }
}
