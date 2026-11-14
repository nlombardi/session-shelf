<div align="center">

<img src="https://raw.githubusercontent.com/nlombardi/session-shelf/main/resources/icon.png" width="96" alt="Session Shelf" />

# Session Shelf

**Organized, persistent session groups for [Claude Code](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code) in VS Code.**
Group conversations by workstream, close tabs freely, and reopen any session from its group.

[![VS Marketplace](https://img.shields.io/visual-studio-marketplace/v/datasense.session-shelf?style=flat-square&color=3ecf8e&labelColor=0f172a&label=Marketplace&logo=visualstudiocode&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=datasense.session-shelf)
[![CI](https://img.shields.io/github/actions/workflow/status/nlombardi/session-shelf/ci.yml?branch=main&style=flat-square&labelColor=0f172a&label=CI)](https://github.com/nlombardi/session-shelf/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-1b64da?style=flat-square&labelColor=0f172a)](LICENSE)
[![Data Sense](https://img.shields.io/badge/by-Data%20Sense-3ecf8e?style=flat-square&labelColor=0f172a)](https://datasenseco.com)

<img src="https://raw.githubusercontent.com/nlombardi/session-shelf/main/media/screenshots/sidebar.png" width="460" alt="Grouped Claude Code sessions with status indicators" />

</div>

---

## Overview

Claude Code opens each conversation as its own editor tab. Once you have more than a handful running, they are hard to keep track of, and closing a tab makes the conversation hard to find again.

Session Shelf adds a structured view of every Claude Code session in your workspace. Sessions live in named, colored groups that persist per workspace. **A grouped session stays in its group after its tab is closed**, so a group works as a durable record of a workstream rather than a snapshot of whatever happens to be open.

## Features

### Organization
- **Persistent groups.** Create named, colored groups and drag sessions between them, or start a new session directly inside a group. Groups collapse and persist per workspace.
- **Closed sessions are retained.** Closing a tab leaves the session in its group, marked as closed. Select it to reopen the conversation where it left off. Use the visibility toggle on a group to show only its open sessions when you want a narrower view.
- **Reliable assignment for new sessions.** A session grouped before Claude Code has written its first transcript keeps its group once it receives a permanent session ID.
- **Pinning.** Keep frequently used sessions at the top.
- **Search.** Fuzzy-find any conversation in the workspace by title or last prompt.

### Visibility
- **Hover preview.** See the latest messages, git branch, context-token count, message count and last-active time without opening the session.
- **Status indicators.** Active, waiting for input, open and closed, at a glance.
- **Waiting-for-input alerts.** When Claude's last turn is an unanswered question or plan, the session moves to the top and the view shows a count badge.
- **Real-time attention (opt-in).** Optional Claude Code hooks raise the alert immediately, with an optional sound and OS notification.
- **Live subagents.** Expand a session to see the subagents it is currently running and inspect their tasks.

### Branches and worktrees
- **Group by branch.** Bucket sessions by the git branch each ran on.
- **Branches view.** List every git worktree of the repository with its sessions.
- **Cross-worktree resume.** Open a session from another worktree in a new window, resumed exactly where it was.
- **New branch session.** Create a worktree for a branch and start a Claude Code session in it in one step.

### Privacy
All data is read from your local `~/.claude` transcripts. Nothing is sent anywhere.

## Screenshots

**Grouped sessions in the Claude Code sidebar**

<img src="https://raw.githubusercontent.com/nlombardi/session-shelf/main/media/screenshots/sidebar.png" width="520" alt="Session tree with a colored group" />

**Hover preview**

<img src="https://raw.githubusercontent.com/nlombardi/session-shelf/main/media/screenshots/hover.png" width="560" alt="Hover preview card" />

**Horizontal strip (bottom panel)**

<img src="https://raw.githubusercontent.com/nlombardi/session-shelf/main/media/screenshots/strip.png" width="620" alt="Horizontal session strip" />

## Installation

1. In VS Code, open **Extensions** (`Ctrl+Shift+X` / `Cmd+Shift+X`) and search for **Session Shelf**, or run:
   ```
   ext install datasense.session-shelf
   ```
2. Make sure the [Claude Code](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code) extension is installed and you have opened at least one conversation.
3. Open **Session Shelf** from the Activity Bar.

**Requirements:** VS Code 1.84 or later (or a compatible fork) and the Claude Code extension.

## Where it appears

| Location | Description |
| --- | --- |
| Activity Bar: **Session Shelf** | The main Sessions tree, always available. |
| Claude Code sidebar: **Session Tabs** | The same tree, shown inside Claude Code's sidebar while it is active. |
| Bottom panel: **Session Shelf** | A horizontal strip of grouped session chips. |

All three views share one data source and stay in sync. Right-click a session or group for actions such as pin, move to group, and rename, recolor or delete a group. The view title bar provides **Search**, **New Group** and **Refresh**.

## Real-time attention (optional)

By default, waiting-for-input alerts are derived from the transcript, which Claude Code does not write in real time. To make alerts immediate, open the view's **...** menu and choose **Enable Real-time Attention**. After confirmation, three [Claude Code hooks](https://docs.claude.com/en/docs/claude-code/hooks) are added to `~/.claude/settings.json`:

| Hook | Fires when | Effect |
| --- | --- | --- |
| `PreToolUse` (`AskUserQuestion` / `ExitPlanMode`) | Claude asks a question or presents a plan | Alert on |
| `Notification` (permission prompt) | Claude needs permission | Alert on |
| `UserPromptSubmit` | You reply | Alert off |

Each hook writes or removes a marker file under `~/.claude/hooks/session-shelf/`, which the extension watches. Stale markers are ignored once the transcript catches up. **Disable Real-time Attention** removes the hooks and scripts and restores your `settings.json`. Start a new Claude Code session, or reload the window, after enabling.

When a session starts waiting, the extension can also play a sound and show a notification: a native OS notification when VS Code is in the background, or an in-app notification with a **Reveal** action when it is focused.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `sessionShelf.maxRecentSessions` | `25` | Maximum closed sessions shown under Ungrouped. Open, pinned and grouped sessions are always shown. |
| `sessionShelf.showClosedSessions` | `true` | Include recently closed sessions, not only open tabs. |
| `sessionShelf.projectDirectory` | `""` | Override the `~/.claude/projects/<slug>` directory. Leave empty to auto-detect. |
| `sessionShelf.attentionSound` | `true` | Play a sound when a session needs input. Requires Real-time Attention. |
| `sessionShelf.attentionNotification` | `true` | Show a notification when a session needs input. Requires Real-time Attention. |
| `sessionShelf.attentionSoundName` | `"Ping"` | macOS system sound to play. Windows and Linux use the system notification sound. |

## How it works

- Claude Code tabs are detected through the VS Code Tab API (`TabInputWebview` with the `claudeVSCodePanel` view type).
- Session content is read from `~/.claude/projects/<workspace>/*.jsonl` and cached by file modification time, so unchanged sessions are never re-parsed.
- Sessions are opened or revealed with the Claude Code command `claude-vscode.editor.open`.
- Groups, assignments and pins are stored in VS Code's per-workspace state.

**Why a sidebar rather than the editor tab bar?** The VS Code extension API cannot customize editor-tab hovers, color or group individual webview tabs, or modify tabs beyond closing them. Extensions that restyle the tab bar do so by patching VS Code's installation files, which breaks on every update. Session Shelf uses supported APIs only. See [DESIGN.md](DESIGN.md) for the full analysis.

## Known limitations

- The views appear in the sidebar and bottom panel; the API cannot render them on the native editor tab bar.
- The Tab API does not expose a tab's session ID, so open tabs are matched to sessions by title. Two sessions with identical truncated titles can occasionally be matched in the wrong order until one of them updates.
- The embedded sidebar view depends on Claude Code's view container. If a future Claude Code release renames it, a small update may be required.

## Development

```bash
npm install
npm run watch      # or: npm run compile
npm test           # headless data-layer and group-store tests
```

Press **F5** to launch an Extension Development Host. Package with `npx @vscode/vsce package --no-dependencies`. The code is layered `model → data → view → wiring`; see [DESIGN.md](DESIGN.md) for details.

## License and attribution

Released under the [MIT License](LICENSE).

Session Shelf is a fork of [Claude Code Tabs](https://github.com/yousefkadah/claude-session-tabs) by yousefkadah, extended so that grouped sessions persist after their tabs are closed. It is not affiliated with or endorsed by Anthropic.

---

<div align="center">

<a href="https://datasenseco.com"><img src="https://raw.githubusercontent.com/nlombardi/session-shelf/main/media/datasense-logo.png" width="48" alt="Data Sense" /></a>

**Built by [Data Sense](https://datasenseco.com)**
*From Raw Data to Real Decisions.*

</div>
