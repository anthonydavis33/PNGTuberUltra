// Generic typed pub/sub for input parameters.
//
// The bus holds the *current value* of each named channel and notifies
// subscribers on change. Use `get(name)` for synchronous reads (PixiJS
// render loop, bindings) and `subscribe(name, fn)` for push updates
// (status bar, dev tooling).
//
// Channels are identified by string. We use a simple string-keyed map
// rather than a discriminated union so new input sources can register
// channels at runtime without modifying this module.

type Listener<T> = (value: T) => void;

interface Channel<T> {
  value: T | undefined;
  listeners: Set<Listener<T>>;
}

class InputBus {
  private channels = new Map<string, Channel<unknown>>();

  /** Set the current value for a channel and notify subscribers. */
  publish<T>(name: string, value: T): void {
    let ch = this.channels.get(name) as Channel<T> | undefined;
    if (!ch) {
      ch = { value: undefined, listeners: new Set() };
      this.channels.set(name, ch as Channel<unknown>);
    }
    ch.value = value;
    for (const listener of ch.listeners) listener(value);
  }

  /** Read the current value synchronously, or undefined if never published. */
  get<T>(name: string): T | undefined {
    return this.channels.get(name)?.value as T | undefined;
  }

  /** Subscribe to changes. Returns an unsubscribe function. */
  subscribe<T>(name: string, listener: Listener<T>): () => void {
    let ch = this.channels.get(name) as Channel<T> | undefined;
    if (!ch) {
      ch = { value: undefined, listeners: new Set() };
      this.channels.set(name, ch as Channel<unknown>);
    }
    ch.listeners.add(listener);
    return () => {
      ch!.listeners.delete(listener);
    };
  }

  /** List all known channel names. Useful for debug UIs. */
  channelNames(): string[] {
    return Array.from(this.channels.keys());
  }
}

/** App-wide singleton. */
export const inputBus = new InputBus();
