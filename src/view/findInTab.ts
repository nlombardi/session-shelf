import * as vscode from 'vscode';

/** Claude Code's conversation webview (see SessionTreeProvider.liveTabs). */
const CLAUDE_VIEW_TYPE = 'claudeVSCodePanel';

/** How long to wait for the conversation's tab to become the active editor. */
const TAB_TIMEOUT_MS = 6000;

/** The find bar focuses its input on the next tick after it is shown. */
const FIND_FOCUS_MS = 100;

/** Give the paste time to read the clipboard before the original text is put back. */
const CLIPBOARD_RESTORE_MS = 300;

function isClaudeTab(tab: vscode.Tab | undefined): tab is vscode.Tab {
  const input = tab?.input;
  return input instanceof vscode.TabInputWebview && input.viewType.includes(CLAUDE_VIEW_TYPE);
}

/** Every open Claude Code conversation tab. */
export function claudeTabs(): Set<vscode.Tab> {
  return new Set(vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter(isClaudeTab));
}

function activeClaudeTab(): vscode.Tab | undefined {
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  return isClaudeTab(tab) ? tab : undefined;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Search the open conversation for `text` with VS Code's find bar, which scrolls to
 * and highlights the first hit. Claude Code has no API to scroll to a message, so this
 * waits for the conversation's tab (`isTarget`) to become the active editor, gives it
 * `renderDelayMs` to draw its messages, opens the find bar and pastes `text` into it.
 * The clipboard is put back afterwards.
 *
 * Does nothing (returns false) if no matching Claude tab becomes active, e.g. when
 * Claude Code opens conversations in the sidebar, or the user switches away meanwhile.
 */
export async function findInClaudeTab(
  text: string,
  isTarget: (tab: vscode.Tab) => boolean,
  renderDelayMs: number,
): Promise<boolean> {
  if (!text) {
    return false;
  }
  const deadline = Date.now() + TAB_TIMEOUT_MS;
  let tab = activeClaudeTab();
  while (!(tab && isTarget(tab))) {
    if (Date.now() > deadline) {
      return false;
    }
    await sleep(100);
    tab = activeClaudeTab();
  }
  await sleep(renderDelayMs);
  if (activeClaudeTab() !== tab) {
    return false;
  }

  const saved = await vscode.env.clipboard.readText();
  try {
    await vscode.env.clipboard.writeText(text);
    await vscode.commands.executeCommand('editor.action.webvieweditor.showFind');
    await sleep(FIND_FOCUS_MS);
    if (activeClaudeTab() !== tab) {
      return false;
    }
    // The find bar's input now has focus (not the chat's iframe), so the paste lands
    // there, replaces any previous search, and triggers the find.
    await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
    await sleep(CLIPBOARD_RESTORE_MS);
    return true;
  } finally {
    await vscode.env.clipboard.writeText(saved);
  }
}
