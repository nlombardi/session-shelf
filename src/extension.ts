import * as vscode from 'vscode';
import * as path from 'path';
import { SessionStore } from './data/sessionStore';
import { GroupStore } from './data/groupStore';
import { AttentionKind, AttentionStore } from './data/attentionStore';
import { consumeHandoff } from './data/handoff';
import { nativeNotify, playSound } from './data/notify';
import { GroupTreeNode, SessionTreeProvider, TreeNode } from './view/sessionTree';
import { WorktreeTreeProvider, WtNode } from './view/worktreeTree';
import { StripViewProvider } from './view/strip/stripView';
import {
  ExtensionServices,
  createStripHandlers,
  openById,
  registerCommands,
  startNewConversation,
} from './commands';
import { debounce } from './util/async';

export function activate(context: vscode.ExtensionContext): void {
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const cfg = () => vscode.workspace.getConfiguration('sessionShelf');
  const override = cfg().get<string>('projectDirectory')?.trim() || undefined;

  const store = new SessionStore(cwd, override);
  const groups = new GroupStore(context.workspaceState);
  const provider = new SessionTreeProvider(store, groups);
  provider.configure(cfg().get('maxRecentSessions', 25), cfg().get('showClosedSessions', true));

  const treeOptions: vscode.TreeViewOptions<TreeNode> = {
    treeDataProvider: provider,
    dragAndDropController: provider,
    showCollapseAll: true,
    canSelectMany: true,
  };
  // Two homes, one data source: a standalone "Session Shelf" container in the
  // Activity Bar, plus a mirror inside the Claude Code sidebar (shown while the
  // Claude Code extension is active). Both share the provider, so they stay in sync.
  const primaryView = vscode.window.createTreeView('sessionShelf', treeOptions);
  const inlineView = vscode.window.createTreeView('sessionShelfInline', treeOptions);
  context.subscriptions.push(primaryView, inlineView, provider, groups);

  for (const v of [primaryView, inlineView]) {
    context.subscriptions.push(
      v.onDidCollapseElement((e) => {
        if (e.element instanceof GroupTreeNode && e.element.group) {
          void groups.setCollapsed(e.element.group.id, true);
        }
      }),
      v.onDidExpandElement((e) => {
        if (e.element instanceof GroupTreeNode && e.element.group) {
          void groups.setCollapsed(e.element.group.id, false);
        }
      }),
    );
  }

  // The Worktrees ("Branches") view: this repo's git worktrees, each with its
  // sessions — the hub for running different branches in parallel. Read-only for
  // other worktrees (clicking one offers to open it in a new window).
  const worktrees = new WorktreeTreeProvider(cwd);
  const worktreeView = vscode.window.createTreeView<WtNode>('sessionShelfWorktrees', {
    treeDataProvider: worktrees,
  });
  context.subscriptions.push(worktrees, worktreeView);

  // Tracks deactivation so async setup (below) doesn't register after teardown.
  let disposed = false;
  context.subscriptions.push({ dispose: () => (disposed = true) });

  // Count on the view icon: sessions where Claude asked, or finished while you weren't looking.
  const updateBadge = (): void => {
    const n = provider.getAttentionCount();
    const badge =
      n > 0 ? { value: n, tooltip: `${n} session${n === 1 ? '' : 's'} waiting for you` } : undefined;
    primaryView.badge = badge;
    inlineView.badge = badge;
  };

  // Serialize rebuilds; coalesce bursts of tab events.
  let building = false;
  let pending = false;
  const rebuild = async (): Promise<void> => {
    if (building) {
      pending = true;
      return;
    }
    building = true;
    try {
      await provider.build();
      // A finished session you're now looking at is "seen" — drop its marker, just
      // as Claude Code clears the dot on its tab icon.
      const seen = vscode.window.state.focused ? provider.getSeenDoneIds() : [];
      if (seen.length) {
        seen.forEach((id) => attention.clear(id));
        provider.forgetAttention(seen);
        await provider.build();
      }
      provider.refresh();
      updateBadge();
    } finally {
      building = false;
      if (pending) {
        pending = false;
        void rebuild();
      }
    }
  };
  const debouncedRebuild = debounce(() => void rebuild(), 250);

  // Worktree data is cross-window (other worktrees' transcripts), so it refreshes on
  // its own cadence: activation, the periodic tick, view focus, and manual Refresh.
  const rebuildWorktrees = async (): Promise<void> => {
    await worktrees.build();
    worktrees.refresh();
  };
  context.subscriptions.push(
    worktreeView.onDidChangeVisibility((e) => {
      if (e.visible) {
        void rebuildWorktrees();
      }
    }),
  );

  // Real-time "needs you" bell, driven by Claude Code hooks (opt-in). Hooks write
  // marker files into attention.d; we watch that directory and re-scan on change.
  const attention = new AttentionStore(context.extensionUri);
  let attentionWatcher: vscode.FileSystemWatcher | undefined;
  // Notify only on the *transition* into "needs you" (a marker id we hadn't seen).
  let knownAttention = new Map<string, AttentionKind>();
  let attentionBaselined = false;

  const fireAttention = (id: string, kind: AttentionKind): void => {
    const wantSound = cfg().get('attentionSound', true);
    const wantNotif = cfg().get('attentionNotification', true);
    if (!wantSound && !wantNotif) {
      return;
    }
    const soundName = cfg().get<string>('attentionSoundName', 'Ping') || 'Ping';
    const title = provider.getEntry(id)?.meta.title || 'A Claude session';
    if (vscode.window.state.focused) {
      // You're in VS Code — show the actionable toast; play the sound alongside.
      if (wantNotif) {
        void vscode.window
          .showInformationMessage(
            kind === 'done' ? `${title} — Claude finished` : `${title} — Claude is waiting for you`,
            'Reveal',
          )
          .then((pick) => {
            if (pick === 'Reveal') {
              void openById(id, provider.getClaudeColumn());
            }
          });
      }
      if (wantSound) {
        playSound(soundName);
      }
    } else if (wantNotif) {
      // You're elsewhere — a native banner surfaces it (and carries the sound).
      nativeNotify(
        'Claude Code',
        kind === 'done' ? `${title} finished` : `${title} needs you`,
        wantSound ? soundName : undefined,
      );
    } else if (wantSound) {
      playSound(soundName);
    }
  };

  const refreshAttention = (): void => {
    const scan = attention.scan();
    const markers = new Map<string, { mtimeMs: number; kind: AttentionKind }>();
    for (const [id, m] of scan) {
      markers.set(id, { mtimeMs: m.mtimeMs, kind: m.kind });
    }
    provider.setAttention(markers);
    void rebuild();

    if (!attentionBaselined) {
      attentionBaselined = true; // don't fire for markers that already existed at startup
    } else {
      const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
      for (const [id, m] of scan) {
        if (knownAttention.get(id) === m.kind) {
          continue; // already knew about it — only fire on the transition
        }
        if (m.kind === 'done') {
          continue; // a finished turn is shown silently (orange dot) — only asks ring
        }
        const belongsHere = m.cwd
          ? folders.some((f) => path.resolve(f) === path.resolve(m.cwd))
          : !!provider.getEntry(id);
        if (belongsHere) {
          fireAttention(id, m.kind);
        }
      }
    }
    knownAttention = new Map([...scan].map(([id, m]) => [id, m.kind]));
  };
  const syncAttention = (): void => {
    const installed = attention.isInstalled();
    void vscode.commands.executeCommand('setContext', 'sessionShelf.attentionInstalled', installed);
    if (installed && !attentionWatcher && !disposed) {
      attention.ensureDir();
      const w = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(AttentionStore.attentionDir), '*'),
      );
      w.onDidChange(refreshAttention);
      w.onDidCreate(refreshAttention);
      w.onDidDelete(refreshAttention);
      attentionWatcher = w;
      context.subscriptions.push(w);
    } else if (!installed && attentionWatcher) {
      attentionWatcher.dispose();
      attentionWatcher = undefined;
      provider.setAttention(new Map());
    }
    refreshAttention();
    if (installed && !outdatedPrompted && attention.isOutdated()) {
      outdatedPrompted = true;
      void vscode.window
        .showInformationMessage(
          'Session Shelf: Real-time Attention can now also flag sessions where Claude finished its turn (like the dot on Claude Code tabs). Update the hooks in ~/.claude/settings.json?',
          'Update hooks',
        )
        .then(async (pick) => {
          if (pick !== 'Update hooks') {
            return;
          }
          try {
            await attention.install();
            syncAttention();
            void vscode.window.showInformationMessage(
              'Hooks updated. New Claude Code sessions pick them up; reload the window to apply them to open ones.',
            );
          } catch (e) {
            void vscode.window.showErrorMessage(`Couldn't update hooks: ${(e as Error).message}`);
          }
        });
    }
  };
  let outdatedPrompted = false;

  const services: ExtensionServices = {
    store,
    groups,
    provider,
    attention,
    rebuild: () => void rebuild(),
    refreshWorktrees: () => void rebuildWorktrees(),
    syncAttention,
  };

  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs(debouncedRebuild),
    vscode.window.tabGroups.onDidChangeTabGroups(debouncedRebuild),
    // Coming back to the window counts as looking at its active Claude tab.
    vscode.window.onDidChangeWindowState((s) => s.focused && debouncedRebuild()),
    groups.onDidChange(() => void rebuild()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('sessionShelf')) {
        provider.configure(cfg().get('maxRecentSessions', 25), cfg().get('showClosedSessions', true));
        void rebuild();
      }
    }),
  );

  // Watch the transcript directory so hovers/state stay fresh as sessions progress.
  void store.resolveDir().then((dir) => {
    if (!dir || disposed) {
      return;
    }
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(dir), '*.jsonl'),
    );
    if (disposed) {
      watcher.dispose(); // extension was deactivated during dir resolution
      return;
    }
    const onFs = (uri: vscode.Uri): void => {
      store.invalidate(uri.fsPath);
      debouncedRebuild();
    };
    watcher.onDidChange(onFs);
    watcher.onDidCreate(onFs);
    watcher.onDidDelete(onFs);
    context.subscriptions.push(watcher);
  });

  // Keep relative timestamps ("2m ago") current.
  // Periodic tick: refresh relative times and drop subagents that are no longer active.
  const timer = setInterval(() => {
    provider.refresh();
    updateBadge();
    void rebuildWorktrees();
  }, 15_000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });

  registerCommands(context, services);

  const strip = new StripViewProvider(context.extensionUri, provider, createStripHandlers(services));
  context.subscriptions.push(
    strip,
    vscode.window.registerWebviewViewProvider(StripViewProvider.viewType, strip, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  void rebuild();
  void rebuildWorktrees();
  // Sets the installed context key and, if hooks are already installed, starts
  // the attention watcher and does an initial scan.
  syncAttention();
  void vscode.commands.executeCommand('setContext', 'sessionShelf.branchMode', groups.isGroupByBranch());

  // Phase 3: if this window was opened by a "resume in worktree" / "new branch"
  // hand-off, consume it and act once Claude Code has had a moment to activate.
  const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  const handoff = folders.length ? consumeHandoff(folders, Date.now()) : undefined;
  if (handoff) {
    const t = setTimeout(() => {
      if (disposed) {
        return;
      }
      if (handoff.sessionId) {
        void openById(handoff.sessionId, provider.getClaudeColumn());
      } else {
        void startNewConversation(provider.getClaudeColumn());
      }
    }, 1500);
    context.subscriptions.push({ dispose: () => clearTimeout(t) });
  }
}

export function deactivate(): void {
  // Subscriptions are disposed by VS Code.
}
