import * as vscode from 'vscode';
import { GroupDef, PersistedState } from '../model/types';

const KEY = 'sessionShelf.state.v1';

let counter = 0;
function genId(): string {
  counter++;
  return 'g' + Date.now().toString(36) + counter.toString(36);
}

/** Persists user-defined groups, per-session group assignments, and pins in workspaceState. */
export class GroupStore implements vscode.Disposable {
  private state: PersistedState;
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private memento: vscode.Memento) {
    this.state = memento.get<PersistedState>(KEY) ?? { groups: [], assignments: {}, pinned: [], version: 1 };
  }

  dispose(): void {
    this._onDidChange.dispose();
  }

  get groups(): GroupDef[] {
    return this.state.groups;
  }

  groupOf(sessionId: string): string | null {
    return this.state.assignments[sessionId] ?? null;
  }

  isPinned(sessionId: string): boolean {
    return this.state.pinned.includes(sessionId);
  }

  /**
   * Whether a bucket (group id, '__ungrouped__', or 'branch:<name>') reveals its closed
   * sessions. User groups default to revealing them; Ungrouped and branch buckets
   * default to hiding them.
   */
  isShowInactive(key: string): boolean {
    if (this.hasGroup(key)) {
      return !(this.state.hideInactive?.includes(key) ?? false);
    }
    return this.state.showInactive?.includes(key) ?? false;
  }

  /** Whether the tree buckets sessions by git branch instead of user groups. */
  isGroupByBranch(): boolean {
    return this.state.groupByBranch ?? false;
  }

  async setGroupByBranch(on: boolean): Promise<void> {
    if (this.isGroupByBranch() !== on) {
      this.state.groupByBranch = on;
      await this.save();
    }
  }

  /** Flip a bucket's "reveal closed sessions" flag. */
  async toggleShowInactive(key: string): Promise<void> {
    const field = this.hasGroup(key) ? 'hideInactive' : 'showInactive';
    const arr = this.state[field] ?? (this.state[field] = []);
    const i = arr.indexOf(key);
    if (i >= 0) {
      arr.splice(i, 1);
    } else {
      arr.push(key);
    }
    await this.save();
  }

  /**
   * Carry a provisional id's group + pin over to a session's real id. A brand-new tab
   * is tracked under a synthetic `live:` id until Claude writes its transcript; without
   * this, anything the user did to it in that window is lost when the tab closes.
   */
  async migrate(fromId: string, toId: string): Promise<void> {
    let changed = false;
    const g = this.state.assignments[fromId];
    if (g !== undefined) {
      if (this.state.assignments[toId] === undefined) {
        this.state.assignments[toId] = g;
      }
      delete this.state.assignments[fromId];
      changed = true;
    }
    const pi = this.state.pinned.indexOf(fromId);
    if (pi >= 0) {
      this.state.pinned.splice(pi, 1);
      if (!this.state.pinned.includes(toId)) {
        this.state.pinned.push(toId);
      }
      changed = true;
    }
    if (changed) {
      await this.save();
    }
  }

  hasGroup(id: string): boolean {
    return this.state.groups.some((g) => g.id === id);
  }

  async createGroup(name: string, color: string): Promise<GroupDef> {
    const g: GroupDef = { id: genId(), name, color, collapsed: false };
    this.state.groups.push(g);
    await this.save();
    return g;
  }

  async renameGroup(id: string, name: string): Promise<void> {
    const g = this.find(id);
    if (g) {
      g.name = name;
      await this.save();
    }
  }

  async recolorGroup(id: string, color: string): Promise<void> {
    const g = this.find(id);
    if (g) {
      g.color = color;
      await this.save();
    }
  }

  async deleteGroup(id: string): Promise<void> {
    this.state.groups = this.state.groups.filter((g) => g.id !== id);
    for (const sessionId of Object.keys(this.state.assignments)) {
      if (this.state.assignments[sessionId] === id) {
        delete this.state.assignments[sessionId];
      }
    }
    if (this.state.showInactive) {
      this.state.showInactive = this.state.showInactive.filter((k) => k !== id);
    }
    if (this.state.hideInactive) {
      this.state.hideInactive = this.state.hideInactive.filter((k) => k !== id);
    }
    await this.save();
  }

  async setCollapsed(id: string, collapsed: boolean): Promise<void> {
    const g = this.find(id);
    if (g && g.collapsed !== collapsed) {
      g.collapsed = collapsed;
      await this.save();
    }
  }

  async assign(sessionId: string, groupId: string | null): Promise<void> {
    if (groupId) {
      this.state.assignments[sessionId] = groupId;
    } else {
      delete this.state.assignments[sessionId];
    }
    await this.save();
  }

  async togglePin(sessionId: string): Promise<void> {
    const i = this.state.pinned.indexOf(sessionId);
    if (i >= 0) {
      this.state.pinned.splice(i, 1);
    } else {
      this.state.pinned.push(sessionId);
    }
    await this.save();
  }

  private find(id: string): GroupDef | undefined {
    return this.state.groups.find((g) => g.id === id);
  }

  private async save(): Promise<void> {
    await this.memento.update(KEY, this.state);
    this._onDidChange.fire();
  }
}
