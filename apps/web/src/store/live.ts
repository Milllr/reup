// The live store: one WebSocket to the hub, every message checked against the contracts, and reconnects with backoff.
import { ServerMessage } from '@reup/contracts';
import { useSyncExternalStore } from 'react';
import { apply, initial, type LiveState } from './reduce';

/** 1, 2, 4, 8 seconds, then 10. */
export const backoff = (attempt: number) => Math.min(10_000, 1000 * 2 ** Math.max(0, attempt));

export interface SocketLike {
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

export class LiveStore {
  private state: LiveState = initial;
  private listeners = new Set<() => void>();
  private attempt = 0;
  private socket: SocketLike | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private stopped = false;

  constructor(private makeSocket: (url: string) => SocketLike = (url) => new WebSocket(url) as unknown as SocketLike, private later: (fn: () => void, ms: number) => ReturnType<typeof setTimeout> = (fn, ms) => setTimeout(fn, ms)) {}

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };

  getState = () => this.state;

  set(patch: Partial<LiveState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  /** Takes anything off the wire. A message that fails its schema is dropped and logged, never applied. */
  receive(raw: unknown, now = Date.now()): boolean {
    let data = raw;
    if (typeof raw === 'string') {
      try {
        data = JSON.parse(raw);
      } catch {
        console.warn('reup: dropped a message that is not JSON');
        return false;
      }
    }
    const parsed = ServerMessage.safeParse(data);
    if (!parsed.success) {
      console.warn('reup: dropped a message that does not match the contract', parsed.error.issues[0]);
      return false;
    }
    this.set(apply(this.state, parsed.data, now));
    return true;
  }

  connect(url: string): void {
    if (this.stopped) return;
    const socket = this.makeSocket(url);
    this.socket = socket;
    socket.onopen = () => {
      this.attempt = 0;
      this.set({ connected: true });
    };
    socket.onmessage = (ev) => void this.receive(ev.data);
    socket.onerror = () => socket.close();
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.set({ connected: false });
      if (this.stopped) return;
      this.timers.push(this.later(() => this.connect(url), backoff(this.attempt)));
      this.attempt += 1;
    };
  }

  ping(): void {
    try {
      this.socket?.send('{"type":"ping"}');
    } catch {
      // the close handler reconnects
    }
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.socket?.close();
  }
}

export const store = new LiveStore();
export const useLive = (): LiveState => useSyncExternalStore(store.subscribe, store.getState, store.getState);
