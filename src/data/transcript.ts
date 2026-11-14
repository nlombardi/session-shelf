import * as fs from 'fs/promises';
import * as path from 'path';
import { SessionMeta } from '../model/types';

// Read whole file below this size; sample head+tail above it.
const FULL_LIMIT = 3_000_000;
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 512 * 1024;

interface Acc {
  customTitle?: string;
  aiTitle?: string;
  lastPrompt?: string;
  summary?: string;
  firstPrompt?: string;
  lastUserText?: string;
  lastAssistantText?: string;
  gitBranch?: string;
  cwd?: string;
  /** The last turn was Claude asking the user (AskUserQuestion / ExitPlanMode), unanswered. */
  pendingAsk: boolean;
  midTurn: boolean;
  lastTurnMs: number;
  messageCount: number;
  contextTokens: number;
  outputTokens: number;
  sidechain: boolean;
}

/** Assistant stop reasons that end Claude's turn (anything else means it continues). */
const TURN_ENDED = new Set(['end_turn', 'stop_sequence', 'max_tokens', 'refusal']);

/**
 * User records Claude never replies to, so they must not make a session look mid-turn:
 * local slash-command echoes/output. An interruption ends the turn outright.
 */
const NO_REPLY_PREFIXES = ['<command-name>', '<command-message>', '<local-command-'];
const INTERRUPTED_PREFIX = '[Request interrupted';

/**
 * Parse a Claude Code transcript into display metadata. Returns null for
 * subagent (sidechain) transcripts, which are excluded from the session list.
 */
export async function parseSession(
  filePath: string,
  size: number,
  mtimeMs: number,
): Promise<SessionMeta | null> {
  const id = path.basename(filePath, '.jsonl');
  const acc: Acc = {
    messageCount: 0,
    contextTokens: 0,
    outputTokens: 0,
    sidechain: false,
    pendingAsk: false,
    midTurn: false,
    lastTurnMs: 0,
  };
  let approx = false;

  if (size <= FULL_LIMIT) {
    const text = await fs.readFile(filePath, 'utf8');
    processLines(text.split('\n'), acc);
  } else {
    approx = true;
    const fh = await fs.open(filePath, 'r');
    try {
      const headBuf = Buffer.alloc(HEAD_BYTES);
      await fh.read(headBuf, 0, HEAD_BYTES, 0);
      const tailBuf = Buffer.alloc(TAIL_BYTES);
      await fh.read(tailBuf, 0, TAIL_BYTES, Math.max(0, size - TAIL_BYTES));
      // Drop the trailing partial line of head and the leading partial line of tail.
      processLines(headBuf.toString('utf8').split('\n').slice(0, -1), acc);
      processLines(tailBuf.toString('utf8').split('\n').slice(1), acc);
    } finally {
      await fh.close();
    }
  }

  if (acc.sidechain) {
    return null;
  }

  const title =
    acc.customTitle || acc.aiTitle || acc.lastPrompt || acc.summary || acc.firstPrompt || 'Claude Code';

  return {
    id,
    filePath,
    title,
    customTitle: acc.customTitle,
    aiTitle: acc.aiTitle,
    lastPrompt: acc.lastPrompt,
    firstPrompt: acc.firstPrompt,
    lastUserText: acc.lastUserText,
    lastAssistantText: acc.lastAssistantText,
    gitBranch: acc.gitBranch,
    cwd: acc.cwd,
    pendingAsk: acc.pendingAsk,
    midTurn: acc.midTurn,
    lastTurnMs: acc.lastTurnMs,
    mtimeMs,
    messageCount: acc.messageCount,
    contextTokens: acc.contextTokens,
    outputTokens: acc.outputTokens,
    approx,
  };
}

/**
 * Read the head of a transcript and return the first `cwd` found on any record.
 * Transcripts commonly begin with queue-operation / ai-title / summary lines that
 * carry no cwd, so scanning only the first line is unreliable.
 */
export async function readCwd(filePath: string): Promise<string | undefined> {
  let fh: fs.FileHandle | undefined;
  try {
    fh = await fs.open(filePath, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
    const lines = buf.toString('utf8', 0, bytesRead).split('\n');
    for (const line of lines) {
      const s = line.trim();
      if (!s) {
        continue;
      }
      try {
        const r = JSON.parse(s);
        if (r && typeof r.cwd === 'string') {
          return r.cwd;
        }
      } catch {
        // Partial trailing line or non-JSON — keep scanning.
      }
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    await fh?.close();
  }
}

type RawRecord = Record<string, unknown> & {
  message?: { content?: unknown; usage?: Record<string, unknown>; stop_reason?: unknown };
};

/** A record's ISO timestamp in ms, or 0 if it has none. */
function timeOf(r: RawRecord): number {
  const t = typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : NaN;
  return Number.isFinite(t) ? t : 0;
}

function processLines(lines: string[], acc: Acc): void {
  for (const line of lines) {
    const s = line.trim();
    if (!s) {
      continue;
    }
    let r: RawRecord;
    try {
      r = JSON.parse(s);
    } catch {
      continue;
    }
    if (!r || typeof r !== 'object') {
      continue;
    }
    if (r.isSidechain === true) {
      acc.sidechain = true;
    }
    if (typeof r.gitBranch === 'string') {
      acc.gitBranch = r.gitBranch;
    }
    if (typeof r.cwd === 'string') {
      acc.cwd = r.cwd;
    }
    switch (r.type) {
      case 'custom-title':
        if (typeof r.customTitle === 'string') {
          acc.customTitle = r.customTitle;
        }
        break;
      case 'ai-title':
        if (typeof r.aiTitle === 'string') {
          acc.aiTitle = r.aiTitle;
        }
        break;
      case 'last-prompt':
        if (typeof r.lastPrompt === 'string') {
          acc.lastPrompt = r.lastPrompt;
        }
        break;
      case 'summary':
        if (typeof r.summary === 'string') {
          acc.summary = r.summary;
        }
        break;
      case 'user': {
        acc.pendingAsk = false; // the user replied, so any pending question is answered
        const t = extractText(r.message?.content);
        // A prompt or tool result hands the turn to Claude, except for injected
        // (isMeta) records, slash-command echoes, and interruptions.
        if (r.isMeta !== true && !NO_REPLY_PREFIXES.some((p) => t.startsWith(p))) {
          acc.midTurn = !t.startsWith(INTERRUPTED_PREFIX);
          acc.lastTurnMs = timeOf(r) || acc.lastTurnMs;
        }
        if (t) {
          if (!acc.firstPrompt) {
            acc.firstPrompt = t;
          }
          acc.lastUserText = t;
          acc.messageCount++;
        }
        break;
      }
      case 'assistant': {
        acc.messageCount++;
        // Claude writes one record per content block; only the final one carries a
        // turn-ending stop reason. A tool_use stop means it is running a tool.
        acc.midTurn = !TURN_ENDED.has(String(r.message?.stop_reason));
        acc.lastTurnMs = timeOf(r) || acc.lastTurnMs;
        if (hasAskTool(r.message?.content)) {
          acc.pendingAsk = true; // Claude asked the user and is waiting on an answer
        }
        const t = extractText(r.message?.content);
        if (t) {
          acc.lastAssistantText = t;
        }
        const u = r.message?.usage;
        if (u) {
          acc.outputTokens += num(u.output_tokens);
          acc.contextTokens =
            num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens);
        }
        break;
      }
      default:
        break;
    }
  }
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** True if the message contains a tool call that blocks on the user (a question / plan approval). */
const ASK_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);
function hasAskTool(content: unknown): boolean {
  if (!Array.isArray(content)) {
    return false;
  }
  for (const b of content) {
    if (b && typeof b === 'object' && (b as { type?: string }).type === 'tool_use') {
      const name = (b as { name?: unknown }).name;
      if (typeof name === 'string' && ASK_TOOLS.has(name)) {
        return true;
      }
    }
  }
  return false;
}

/** Pull only human-visible text out of a message's content (skips thinking, tool calls, images). */
export function extractText(content: unknown): string {
  if (typeof content === 'string') {
    return content.trim();
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const b of content) {
      if (!b) {
        continue;
      }
      if (typeof b === 'string') {
        parts.push(b);
      } else if (typeof b === 'object' && (b as { type?: string }).type === 'text') {
        const text = (b as { text?: unknown }).text;
        if (typeof text === 'string') {
          parts.push(text);
        }
      }
    }
    return parts.join('\n').trim();
  }
  return '';
}
