export class DeferredNotifications<T> {
  private readonly pending = new Map<string, T>();

  constructor(
    private readonly isIdle: () => boolean,
    private readonly deliver: (value: T) => void,
  ) {}

  complete(key: string, value: T): void {
    if (!this.isIdle()) {
      this.pending.set(key, value);
      return;
    }
    this.deliverOrRetain(key, value);
  }

  claim(key: string): void {
    this.pending.delete(key);
  }

  flush(): void {
    for (const [key, value] of this.pending) this.deliverOrRetain(key, value);
  }

  clear(): void {
    this.pending.clear();
  }

  private deliverOrRetain(key: string, value: T): void {
    try {
      this.deliver(value);
      this.pending.delete(key);
    } catch {
      this.pending.set(key, value);
    }
  }
}
