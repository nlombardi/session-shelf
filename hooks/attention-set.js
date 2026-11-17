#!/usr/bin/env node
/*
 * Session Shelf — attention SET hook.
 *
 * Registered by the extension on:
 *   - PreToolUse  (matcher: AskUserQuestion|ExitPlanMode)  → Claude is asking you
 *   - Notification (notification_type: permission_prompt)  → Claude needs permission
 *   - Stop (argv[2] === 'done')                            → Claude finished its turn
 *
 * Writes a per-session marker file that the extension watches, so the
 * "needs you" bell lights up instantly — no waiting on the transcript, which
 * Claude Code doesn't flush in real time.
 *
 * Contract: read the hook payload from stdin, do the side effect, exit 0 with
 * no stdout so the tool call is always allowed. Never throw.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  try {
    const j = JSON.parse(raw || '{}');
    // The Notification hook also fires for non-attention events; only permission
    // prompts count. PreToolUse payloads carry no notification_type, so they pass.
    if (j.notification_type && j.notification_type !== 'permission_prompt') {
      return;
    }
    const sid = String(j.session_id || '').replace(/[^A-Za-z0-9_-]/g, '');
    if (!sid) {
      return;
    }
    const dir = path.join(os.homedir(), '.claude', 'hooks', 'session-shelf', 'attention.d');
    fs.mkdirSync(dir, { recursive: true });
    // Overwrite (not append) so the file's mtime tracks the latest attention event.
    // Body is JSON: the session cwd (scopes notifications to the owning window) and the
    // kind — 'ask' (a question/plan/permission) or 'done' (finished, not yet seen).
    const kind = process.argv[2] === 'done' ? 'done' : 'ask';
    fs.writeFileSync(path.join(dir, sid), JSON.stringify({ cwd: String(j.cwd || ''), kind }));
  } catch {
    // A hook must never interrupt Claude Code — swallow everything.
  }
});
