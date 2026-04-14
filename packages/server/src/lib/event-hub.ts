type Listener = (payload: string) => void;

export class EventHub {
  private listeners = new Map<string, Set<Listener>>();

  subscribe(threadId: string, listener: Listener) {
    const threadListeners = this.listeners.get(threadId) ?? new Set<Listener>();
    threadListeners.add(listener);
    this.listeners.set(threadId, threadListeners);

    return () => {
      const current = this.listeners.get(threadId);
      if (!current) return;

      current.delete(listener);
      if (current.size === 0) {
        this.listeners.delete(threadId);
      }
    };
  }

  publish(threadId: string, payload: string) {
    const listeners = this.listeners.get(threadId);
    if (!listeners) return;

    for (const listener of listeners) {
      listener(payload);
    }
  }
}
