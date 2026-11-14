import * as vscode from 'vscode';
import * as path from 'path';
import { SessionStore } from './data/sessionStore';
import { GroupStore } from './data/groupStore';
import { AttentionStore } from './data/attentionStore';
import { addWorktree, listBranches } from './data/git';
import { writeNewSessionHandoff, writeOpenHandoff } from './data/handoff';
import { SessionTreeProvider, TreeNode, UNGROUPED_ID } from './view/sessionTree';
import { WtNode } from './view/worktreeTree';
import { StripHandlers } from './view/strip/stripView';
import { showSubagentPanel } from './view/subagent/subagentPanel';
import { formatRelative, truncate } from './util/format';
import { debounce } from './util/async';
import { ContentIndex, SearchDoc } from './data/contentSearch';
import { GroupDef, SessionEntry } from './model/types';
import { needsAction } from './view/sessionItem';

const COLORS: { label: string; id: string }[] = [
  { label: 'Blue', id: 'charts.blue' },
  { label: 'Green', id: 'charts.green' },
  { label: 'Orange', id: 'charts.orange' },
  { label: 'Purple', id: 'charts.purple' },
  { label: 'Red', id: 'charts.red' },
  { label: 'Yellow', id: 'charts.yellow' },
  { label: 'Neutral', id: 'charts.foreground' },
];

/** Shared services the commands and the strip act on. */
export interface ExtensionServices {
  store: SessionStore;
  groups: GroupStore;
  provider: SessionTreeProvider;
  attention: AttentionStore;
  /** Fire-and-forget rebuild of the tree + strip. */
  rebuild: () => void;
  /** Fire-and-forget rebuild of the Worktrees view. */
  refreshWorktrees: () => void;
  /** Re-evaluate hook install state: (re)start/stop the watcher and rescan markers. */
  syncAttention: () => void;
}

export function registerCommands(context: vscode.ExtensionContext, services: ExtensionServices): void {
  const { store, groups, provider, attention, rebuild, refreshWorktrees, syncAttention } = services;
  const reg = (id: string, fn: (...args: never[]) => unknown): void => {
    context.subscriptions.push(vscode.commands.registerCommand(id, fn as (...args: unknown[]) => unknown));
  };

  reg('sessionShelf.refresh', () => {
    store.invalidateAll();
    rebuild();
    refreshWorktrees();
  });

  reg('sessionShelf.openSession', async (node?: TreeNode) => {
    if (node?.kind !== 'session') {
      return;
    }
    if (!node.entry.meta.filePath) {
      void vscode.window.showInformationMessage('This session tab is already open.');
      return;
    }
    // Reveal an already-open session in place; open a closed one beside the Claude tabs.
    const column = node.entry.open ? undefined : provider.getClaudeColumn();
    await openById(node.entry.meta.id, column);
  });

  reg('sessionShelf.closeTab', async (node?: TreeNode) => {
    if (node?.kind === 'session' && node.entry.live) {
      await vscode.window.tabGroups.close(node.entry.live.tab);
    }
  });

  reg('sessionShelf.openSubagent', async (node?: TreeNode) => {
    if (node?.kind === 'subagent') {
      await showSubagentPanel(node.sub);
    }
  });

  // Open a session from the Worktrees view. In this worktree → open normally.
  // In another worktree → open that folder in a new window and resume it there.
  reg('sessionShelf.openWorktreeSession', async (node?: WtNode) => {
    if (!node || node.kind !== 'wtsession') {
      return;
    }
    const id = node.entry.meta.id;
    if (node.isCurrent) {
      const e = provider.getEntry(id);
      await openById(id, e?.open ? undefined : provider.getClaudeColumn());
      return;
    }
    const title = node.entry.meta.title || 'Session';
    const pick = await vscode.window.showInformationMessage(
      `"${title}" is on branch ${node.worktree.branch} in another worktree. Open that worktree in a new window and resume it?`,
      'Open in New Window',
    );
    if (pick !== 'Open in New Window') {
      return;
    }
    writeOpenHandoff(node.worktree.path, id, Date.now());
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(node.worktree.path), {
      forceNewWindow: true,
    });
  });

  // Create a git worktree for a branch and start a fresh Claude session in it.
  reg('sessionShelf.newBranchSession', async () => {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd) {
      void vscode.window.showInformationMessage('Open a folder first.');
      return;
    }
    const branches = await listBranches(cwd);
    type Item = vscode.QuickPickItem & { branch?: string; create?: boolean };
    const items: Item[] = [
      { label: '$(add) New branch…', create: true },
      ...branches.map((b) => ({ label: `$(git-branch) ${b}`, branch: b })),
    ];
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: 'Branch to run in a new worktree',
    });
    if (!pick) {
      return;
    }
    let branch: string;
    let createBranch: boolean;
    if (pick.create) {
      const name = await vscode.window.showInputBox({
        prompt: 'New branch name',
        placeHolder: 'e.g. feature/login',
        validateInput: (v) => (v.trim() ? undefined : 'Enter a branch name'),
      });
      if (!name || !name.trim()) {
        return;
      }
      branch = name.trim();
      createBranch = true;
    } else {
      branch = pick.branch as string;
      createBranch = false;
    }
    const safe = branch.replace(/[^A-Za-z0-9._-]/g, '-');
    const defaultDest = path.join(path.dirname(cwd), `${path.basename(cwd)}-${safe}`);
    const dest = await vscode.window.showInputBox({
      prompt: 'Worktree location (a new folder)',
      value: defaultDest,
      valueSelection: [defaultDest.length, defaultDest.length],
    });
    if (!dest || !dest.trim()) {
      return;
    }
    const res = await addWorktree(cwd, dest.trim(), branch, createBranch);
    if (!res.ok) {
      void vscode.window.showErrorMessage(`git worktree add failed: ${res.error}`);
      return;
    }
    writeNewSessionHandoff(dest.trim(), Date.now());
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(dest.trim()), {
      forceNewWindow: true,
    });
  });

  reg('sessionShelf.newGroup', async () => {
    await createGroupInteractive(groups);
  });

  reg('sessionShelf.newSessionInGroup', async (node?: TreeNode) => {
    if (node?.kind !== 'group' || !node.group) {
      return;
    }
    // Queue the group; the next new session that appears joins it (after its first message).
    provider.setPendingGroup(node.group.id);
    await startNewConversation(provider.getClaudeColumn());
    void vscode.window.showInformationMessage(`The next new session will be added to "${node.group.name}".`);
  });

  reg('sessionShelf.renameGroup', async (node?: TreeNode) => {
    if (node?.kind !== 'group' || !node.group) {
      return;
    }
    const name = await vscode.window.showInputBox({ prompt: 'Rename group', value: node.group.name });
    if (name && name.trim()) {
      await groups.renameGroup(node.group.id, name.trim());
    }
  });

  reg('sessionShelf.recolorGroup', async (node?: TreeNode) => {
    if (node?.kind !== 'group' || !node.group) {
      return;
    }
    const color = await pickColor();
    if (color) {
      await groups.recolorGroup(node.group.id, color);
    }
  });

  reg('sessionShelf.deleteGroup', async (node?: TreeNode) => {
    if (node?.kind !== 'group' || !node.group) {
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      `Delete group "${node.group.name}"? Sessions stay — they just become ungrouped.`,
      { modal: true },
      'Delete',
    );
    if (choice === 'Delete') {
      await groups.deleteGroup(node.group.id);
    }
  });

  reg('sessionShelf.assignToGroup', async (node?: TreeNode) => {
    if (node?.kind !== 'session') {
      return;
    }
    const target = await pickGroupTarget(groups);
    if (target !== undefined) {
      await groups.assign(node.entry.meta.id, target);
    }
  });

  reg('sessionShelf.removeFromGroup', async (node?: TreeNode) => {
    if (node?.kind === 'session') {
      await groups.assign(node.entry.meta.id, null);
    }
  });

  reg('sessionShelf.togglePin', async (node?: TreeNode) => {
    if (node?.kind === 'session') {
      await groups.togglePin(node.entry.meta.id);
    }
  });

  // Show/Hide closed sessions in a bucket (both share one handler; two commands only
  // so the inline icon can differ by current state). node.key covers groups, Ungrouped,
  // and branch buckets alike.
  const toggleInactive = async (node?: TreeNode): Promise<void> => {
    if (node?.kind !== 'group') {
      return;
    }
    await groups.toggleShowInactive(node.key);
  };
  reg('sessionShelf.showInactive', toggleInactive);
  reg('sessionShelf.hideInactive', toggleInactive);

  // Toggle between grouping by user groups and grouping by git branch.
  reg('sessionShelf.groupByBranch', async () => {
    await groups.setGroupByBranch(true);
    void vscode.commands.executeCommand('setContext', 'sessionShelf.branchMode', true);
  });
  reg('sessionShelf.groupByGroup', async () => {
    await groups.setGroupByBranch(false);
    void vscode.commands.executeCommand('setContext', 'sessionShelf.branchMode', false);
  });

  reg('sessionShelf.enableAttention', async () => {
    const proceed = await vscode.window.showInformationMessage(
      attention.describeInstall(),
      { modal: true },
      'Install hooks',
    );
    if (proceed !== 'Install hooks') {
      return;
    }
    try {
      await attention.install();
    } catch (e) {
      void vscode.window.showErrorMessage(`Couldn't install hooks: ${(e as Error).message}`);
      return;
    }
    syncAttention();
    void vscode.window.showInformationMessage(
      'Real-time attention enabled. Start a new Claude Code session (or reload the window) so it picks up the hooks.',
    );
  });

  reg('sessionShelf.disableAttention', async () => {
    await attention.uninstall();
    syncAttention();
    void vscode.window.showInformationMessage('Real-time attention disabled — hooks removed from ~/.claude.');
  });

  // Titles filter as you type; from MIN_CONTENT_QUERY characters on, the text of every
  // conversation (your prompts and Claude's replies) is searched too.
  reg('sessionShelf.search', async () => {
    const metas = await store.list();
    const docs: SearchDoc[] = metas.map((m) => ({ id: m.id, filePath: m.filePath }));
    const metaById = new Map(metas.map((m) => [m.id, m]));
    type Item = vscode.QuickPickItem & { id?: string };
    const titleItems: Item[] = metas.map((m) => ({
      label: m.title || 'Claude Code',
      description: formatRelative(m.mtimeMs),
      detail: m.lastUserText ? '$(comment) ' + truncate(m.lastUserText, 90) : undefined,
      id: m.id,
    }));

    const qp = vscode.window.createQuickPick<Item>();
    qp.placeholder = 'Search sessions by title, or type 3+ characters to search inside conversations';
    qp.matchOnDescription = true;
    qp.matchOnDetail = true;
    qp.items = titleItems;

    let closed = false;
    let generation = 0;
    // Read transcripts into the index while the user is still typing.
    void contentIndex.warm(docs, () => closed);

    const runContentSearch = debounce(async (value: string, gen: number) => {
      const query = value.trim();
      if (query.length < MIN_CONTENT_QUERY) {
        qp.busy = false;
        qp.items = titleItems;
        return;
      }
      qp.busy = true;
      const stale = (): boolean => closed || gen !== generation;
      const hits = await contentIndex.search(docs, query, stale);
      if (stale()) {
        return;
      }
      qp.busy = false;
      const hitIds = new Set(hits.map((h) => h.id));
      const contentItems: Item[] = hits.map((h) => {
        const m = metaById.get(h.id);
        const count = `${h.matches} matching message${h.matches === 1 ? '' : 's'}`;
        return {
          label: m?.title || 'Claude Code',
          description: m ? `${count} · ${formatRelative(m.mtimeMs)}` : count,
          detail: `${h.role === 'user' ? '$(account) You' : '$(sparkle) Claude'}: ${h.snippet}`,
          // The snippet may not contain the query verbatim (terms can be apart), so
          // don't let the quick pick's own filter hide a real match.
          alwaysShow: true,
          id: h.id,
        };
      });
      const sep = (label: string): Item => ({ label, kind: vscode.QuickPickItemKind.Separator });
      qp.items = [
        ...(contentItems.length ? [sep('In conversations'), ...contentItems] : [sep('No conversation matches')]),
        sep('Titles'),
        ...titleItems.filter((i) => !hitIds.has(i.id as string)),
      ];
    }, 200);

    qp.onDidChangeValue((v) => runContentSearch(v, ++generation));
    qp.onDidAccept(() => {
      const id = qp.selectedItems[0]?.id;
      qp.hide();
      if (id) {
        void openById(id, provider.getEntry(id)?.open ? undefined : provider.getClaudeColumn());
      }
    });
    qp.onDidHide(() => {
      closed = true;
      qp.dispose();
    });
    qp.show();
  });

  // --- Whole-group tab actions ---

  reg('sessionShelf.openGroup', async (node?: TreeNode) => {
    const g = await resolveGroup(node, groups, 'Open all sessions in group');
    if (!g) {
      return;
    }
    // Re-read tabs first: VS Code replaces Tab objects when editor groups change.
    await provider.build();
    const toOpen = reopenable(provider.getGroupEntries(g.id));
    if (!toOpen.length) {
      void vscode.window.showInformationMessage(`Every session in "${g.name}" is already open.`);
      return;
    }
    if (await confirmBulkOpen(toOpen.length)) {
      await openSessions(provider, toOpen, `Opening "${g.name}"`);
    }
  });

  reg('sessionShelf.closeGroup', async (node?: TreeNode) => {
    const g = await resolveGroup(node, groups, 'Close all tabs in group');
    if (!g) {
      return;
    }
    // Re-read tabs first: VS Code replaces Tab objects when editor groups change.
    await provider.build();
    const open = provider.getGroupEntries(g.id).filter((e) => e.live);
    if (!open.length) {
      void vscode.window.showInformationMessage(`No sessions in "${g.name}" are open.`);
      return;
    }
    const kept = open.filter(isWorking);
    await closeEntries(open.filter((e) => !isWorking(e)));
    reportKept(kept);
  });

  // Close the Claude tabs that aren't in this group, then open the group's sessions.
  reg('sessionShelf.switchToGroup', async (node?: TreeNode) => {
    const g = await resolveGroup(node, groups, 'Switch to group');
    if (!g) {
      return;
    }
    // Re-read tabs first: VS Code replaces Tab objects when editor groups change.
    await provider.build();
    const toOpen = reopenable(provider.getGroupEntries(g.id));
    // Only close tabs that can be reopened from the shelf (they have a transcript),
    // and leave pinned sessions alone.
    const others = provider
      .getOpenEntries()
      .filter((e) => e.groupId !== g.id && !e.pinned && !!e.meta.filePath);
    const kept = others.filter(isWorking);
    const toClose = others.filter((e) => !isWorking(e));
    if (!toOpen.length && !toClose.length) {
      reportKept(kept, `Already on "${g.name}".`);
      return;
    }
    if (!(await confirmBulkOpen(toOpen.length))) {
      return;
    }
    await closeEntries(toClose);
    await openSessions(provider, toOpen, `Switching to "${g.name}"`);
    reportKept(kept);
  });
}

/** Search query length at which conversation text is searched, not just titles. */
const MIN_CONTENT_QUERY = 3;

/** Opening more sessions than this at once asks for confirmation first. */
const BULK_OPEN_CONFIRM = 6;

/**
 * A mid-turn session whose last message is older than this is assumed stalled (crashed,
 * or abandoned at a permission prompt) rather than working, so bulk close may close it.
 */
const STALLED_MS = 30 * 60_000;

const contentIndex = new ContentIndex();

/**
 * Claude is in the middle of a turn in this session. Bulk close leaves such tabs open,
 * because closing a Claude tab mid-turn interrupts it. Decided from the transcript's
 * last message, not the file's mtime: Claude Code also appends bookkeeping records
 * (cost-state, mode, …) to idle sessions, especially right after they are opened.
 */
function isWorking(e: SessionEntry): boolean {
  const m = e.meta;
  return !!m.filePath && m.midTurn && !needsAction(e) && Date.now() - m.lastTurnMs < STALLED_MS;
}

/** Closed sessions that have a transcript, oldest first (so the newest ends up focused). */
function reopenable(entries: SessionEntry[]): SessionEntry[] {
  return entries.filter((e) => !e.open && !!e.meta.filePath).sort((a, b) => a.meta.mtimeMs - b.meta.mtimeMs);
}

/** The group a command applies to: the clicked group, or one picked from a list. */
async function resolveGroup(
  node: TreeNode | undefined,
  groups: GroupStore,
  placeHolder: string,
): Promise<GroupDef | undefined> {
  if (node) {
    return node.kind === 'group' && node.group ? node.group : undefined;
  }
  if (!groups.groups.length) {
    void vscode.window.showInformationMessage('No groups yet. Create one with "New Group…".');
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(
    groups.groups.map((g) => ({ label: `$(folder) ${g.name}`, group: g })),
    { placeHolder },
  );
  return pick?.group;
}

async function confirmBulkOpen(count: number): Promise<boolean> {
  if (count <= BULK_OPEN_CONFIRM) {
    return true;
  }
  const choice = await vscode.window.showWarningMessage(
    `Open ${count} sessions? Each one opens as its own tab.`,
    { modal: true },
    'Open',
  );
  return choice === 'Open';
}

async function openSessions(provider: SessionTreeProvider, entries: SessionEntry[], title: string): Promise<void> {
  if (!entries.length) {
    return;
  }
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title, cancellable: true },
    async (progress, token) => {
      for (const [i, e] of entries.entries()) {
        if (token.isCancellationRequested) {
          return;
        }
        progress.report({ message: `${i + 1} of ${entries.length}`, increment: 100 / entries.length });
        // Re-read the column each time: once the first session opens, the rest join it.
        await openById(e.meta.id, provider.getClaudeColumn());
      }
    },
  );
}

async function closeEntries(entries: SessionEntry[]): Promise<void> {
  // Close only tabs that still exist: tabGroups.close rejects the whole batch if any
  // tab object is stale.
  const current = new Set(vscode.window.tabGroups.all.flatMap((g) => g.tabs));
  const tabs = entries.map((e) => e.live?.tab).filter((t): t is vscode.Tab => !!t && current.has(t));
  if (!tabs.length) {
    return;
  }
  try {
    await vscode.window.tabGroups.close(tabs);
  } catch (err) {
    void vscode.window.showErrorMessage(`Couldn't close tabs: ${(err as Error).message}`);
  }
}

/** Tell the user which sessions were left open because they were still working. */
function reportKept(kept: SessionEntry[], prefix?: string): void {
  if (!kept.length) {
    if (prefix) {
      void vscode.window.showInformationMessage(prefix);
    }
    return;
  }
  const names = kept.map((e) => `"${truncate(e.meta.title || 'Claude Code', 40)}"`).join(', ');
  const msg = `Left open ${kept.length === 1 ? 'a session' : `${kept.length} sessions`} where Claude is still working: ${names}.`;
  void vscode.window.showInformationMessage(prefix ? `${prefix} ${msg}` : msg);
}

/** Message handler for the webview strip, sharing the same services. */
export function createStripHandlers(services: ExtensionServices): StripHandlers {
  const { store, groups, provider, rebuild } = services;
  return {
    onMessage: (msg) => {
      switch (msg.type) {
        case 'open': {
          if (!msg.id) {
            return;
          }
          const e = provider.getEntry(msg.id);
          if (e && !e.meta.filePath) {
            void vscode.window.showInformationMessage('This session tab is already open.');
            return;
          }
          void openById(msg.id, e?.open ? undefined : provider.getClaudeColumn());
          break;
        }
        case 'close': {
          const e = msg.id ? provider.getEntry(msg.id) : undefined;
          if (e?.live) {
            void vscode.window.tabGroups.close(e.live.tab);
          }
          break;
        }
        case 'pin':
          if (msg.id) {
            void groups.togglePin(msg.id);
          }
          break;
        case 'move':
          if (msg.id) {
            void groups.assign(msg.id, msg.groupId ?? null);
          }
          break;
        case 'toggleInactive':
          void groups.toggleShowInactive(msg.groupId ?? UNGROUPED_ID);
          break;
        case 'newGroup':
          void createGroupInteractive(groups);
          break;
        case 'search':
          void vscode.commands.executeCommand('sessionShelf.search');
          break;
        case 'refresh':
          store.invalidateAll();
          rebuild();
          break;
        default:
          break;
      }
    },
  };
}

export async function openById(sessionId: string, column?: vscode.ViewColumn): Promise<void> {
  // For an already-open session, pass ViewColumn.Active so Claude reveals/focuses it
  // in place. For a closed one, pass the Claude tabs' column so it opens beside them
  // rather than over the code editor.
  const target = column ?? vscode.ViewColumn.Active;
  try {
    await vscode.commands.executeCommand('claude-vscode.editor.open', sessionId, undefined, target);
  } catch {
    try {
      await vscode.commands.executeCommand('claude-vscode.primaryEditor.open', sessionId);
    } catch {
      try {
        const uri = `vscode://anthropic.claude-code/open?session=${encodeURIComponent(sessionId)}`;
        await vscode.env.openExternal(vscode.Uri.parse(uri));
      } catch {
        void vscode.window.showErrorMessage(
          'Could not open the session. Make sure the Claude Code extension is installed and enabled.',
        );
      }
    }
  }
}

/**
 * Open a fresh Claude conversation as an editor tab so we can detect it. Opens in
 * `column` (where the existing Claude tabs live) when known, so the new session
 * lands beside them instead of over the code editor.
 */
export async function startNewConversation(column?: vscode.ViewColumn): Promise<void> {
  const target = column ?? vscode.ViewColumn.Active;
  try {
    await vscode.commands.executeCommand('claude-vscode.editor.open', undefined, undefined, target);
  } catch {
    try {
      await vscode.commands.executeCommand('claude-vscode.primaryEditor.open');
    } catch {
      void vscode.window.showErrorMessage(
        'Could not start a new Claude session. Make sure the Claude Code extension is installed.',
      );
    }
  }
}

async function pickColor(): Promise<string | undefined> {
  const pick = await vscode.window.showQuickPick(
    COLORS.map((c) => ({ label: `$(circle-filled) ${c.label}`, id: c.id })),
    { placeHolder: 'Group color' },
  );
  return pick?.id;
}

/** Returns the chosen group id, null for "Ungrouped", or undefined if cancelled. */
async function pickGroupTarget(groups: GroupStore): Promise<string | null | undefined> {
  type Item = vscode.QuickPickItem & { id: string | null | '__new__' };
  const items: Item[] = [
    { label: '$(circle-slash) Ungrouped', id: null },
    ...groups.groups.map((g) => ({ label: `$(folder) ${g.name}`, id: g.id as string | null })),
    { label: '$(new-folder) New group…', id: '__new__' as const },
  ];
  const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Move session to group' });
  if (!pick) {
    return undefined;
  }
  if (pick.id === '__new__') {
    const g = await createGroupInteractive(groups);
    return g ? g.id : undefined;
  }
  return pick.id;
}

async function createGroupInteractive(groups: GroupStore) {
  const name = await vscode.window.showInputBox({ prompt: 'Group name', placeHolder: 'e.g. Feature work' });
  if (!name || !name.trim()) {
    return undefined;
  }
  const color = await pickColor();
  if (!color) {
    return undefined;
  }
  return groups.createGroup(name.trim(), color);
}
