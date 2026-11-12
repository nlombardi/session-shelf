/** GroupStore behaviour: closed sessions stay in groups; provisional ids migrate. */
import { GroupStore } from '../src/data/groupStore';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) {
    failures++;
  }
  console.log(`  ${cond ? '✓' : '✗'} ${name}`);
}

class MemMemento {
  private data = new Map<string, unknown>();
  get<T>(k: string): T | undefined {
    return this.data.get(k) as T | undefined;
  }
  async update(k: string, v: unknown): Promise<void> {
    this.data.set(k, JSON.parse(JSON.stringify(v)));
  }
}

async function main(): Promise<void> {
  console.log('GroupStore');
  const mem = new MemMemento();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const store = new GroupStore(mem as any);
  const g = await store.createGroup('Work', 'blue');

  check('user group reveals closed sessions by default', store.isShowInactive(g.id));
  check('Ungrouped hides closed sessions by default', !store.isShowInactive('__ungrouped__'));

  await store.toggleShowInactive(g.id);
  check('toggling a user group hides its closed sessions', !store.isShowInactive(g.id));
  await store.toggleShowInactive(g.id);
  check('toggling again reveals them', store.isShowInactive(g.id));
  await store.toggleShowInactive('__ungrouped__');
  check('Ungrouped toggle still reveals', store.isShowInactive('__ungrouped__'));

  await store.assign('live:1:Claude Code:0', g.id);
  await store.togglePin('live:1:Claude Code:0');
  await store.migrate('live:1:Claude Code:0', 'real-session-id');
  check('migrate moves group to real id', store.groupOf('real-session-id') === g.id);
  check('migrate drops provisional assignment', store.groupOf('live:1:Claude Code:0') === null);
  check('migrate moves pin', store.isPinned('real-session-id') && !store.isPinned('live:1:Claude Code:0'));

  const other = await store.createGroup('Other', 'red');
  await store.assign('live:x', other.id);
  await store.migrate('live:x', 'real-session-id');
  check('migrate never overrides an existing real assignment', store.groupOf('real-session-id') === g.id);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reloaded = new GroupStore(mem as any);
  check('assignment persists across reload (tab closed / window reopened)', reloaded.groupOf('real-session-id') === g.id);

  await store.toggleShowInactive(g.id);
  await store.deleteGroup(g.id);
  check('deleteGroup clears hideInactive', !(mem.get<{ hideInactive?: string[] }>('sessionShelf.state.v1')?.hideInactive ?? []).includes(g.id));

  if (failures) {
    console.log(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log('\nall passed');
}
void main();
