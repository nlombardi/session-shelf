/** Minimal stand-in for the `vscode` module so pure-ish stores can run under node. */
export class EventEmitter<T> {
  private listeners: ((e: T) => void)[] = [];
  readonly event = (l: (e: T) => void): void => {
    this.listeners.push(l);
  };
  fire(e: T): void {
    this.listeners.forEach((l) => l(e));
  }
  dispose(): void {
    this.listeners = [];
  }
}
