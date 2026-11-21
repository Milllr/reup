// The buyer's link to the hub: one WebSocket for jobs, plain POSTs for results. Reconnects with backoff,
// and asks for the open jobs on every connect in case it missed a message.
import { Job, JobsResult, ServerMessage, Snapshot, type Supplier } from '@reup/contracts';

export const backoff = (attempt: number) => Math.min(10_000, 1000 * 2 ** Math.max(0, attempt));

export interface Socket {
  on(event: 'open' | 'close' | 'error', fn: () => void): void;
  on(event: 'message', fn: (data: unknown) => void): void;
  send(data: string): void;
  close(): void;
}

export interface LinkDeps {
  hubUrl: string;
  token: string;
  makeSocket(url: string): Socket;
  fetch: typeof fetch;
  later(fn: () => void, ms: number): unknown;
  onJob(job: Job): void;
  log(line: string): void;
}

export class HubLink {
  private attempt = 0;
  private seen = new Set<string>();
  private socket: Socket | null = null;
  private suppliersCache: Supplier[] | null = null;
  private stopped = false;

  constructor(private deps: LinkDeps) {}

  private headers(): Record<string, string> {
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${this.deps.token}` };
  }

  /** Hands a job to the handler once, however many times the hub mentions it. */
  private take(job: Job): void {
    if (this.seen.has(job.id)) return;
    this.seen.add(job.id);
    this.deps.onJob(job);
  }

  async missedJobs(): Promise<void> {
    try {
      const res = await this.deps.fetch(`${this.deps.hubUrl}/api/jobs`, { headers: this.headers() });
      if (!res.ok) return this.deps.log(`The hub answered ${res.status} to GET /api/jobs. Check DEVICE_TOKEN.`);
      for (const job of JobsResult.parse(await res.json()).jobs) this.take(job);
    } catch (err) {
      this.deps.log(`Could not ask the hub for jobs: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  connect(): void {
    if (this.stopped) return;
    const url = `${this.deps.hubUrl.replace(/^http/, 'ws')}/live?role=buyer&token=${encodeURIComponent(this.deps.token)}`;
    const socket = this.deps.makeSocket(url);
    this.socket = socket;
    let closed = false;
    const lost = () => {
      if (closed) return;
      closed = true;
      if (this.stopped) return;
      const wait = backoff(this.attempt);
      this.attempt += 1;
      this.deps.log(`Hub connection lost. Trying again in ${wait / 1000} s.`);
      this.deps.later(() => this.connect(), wait);
    };
    socket.on('open', () => {
      this.attempt = 0;
      this.deps.log('Connected to the hub.');
      void this.missedJobs();
    });
    socket.on('message', (data) => {
      let parsed;
      try {
        parsed = ServerMessage.safeParse(JSON.parse(String(data)));
      } catch {
        return;
      }
      if (!parsed.success) return;
      if (parsed.data.type === 'job') this.take(Job.parse(parsed.data.job));
      if (parsed.data.type === 'snapshot') this.suppliersCache = parsed.data.snapshot.suppliers;
    });
    socket.on('close', lost);
    socket.on('error', lost);
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
    this.socket?.close();
  }

  /** Posts a result. Tries three times, because a result that never lands leaves an order stuck. */
  async post(path: string, body: unknown): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await this.deps.fetch(`${this.deps.hubUrl}${path}`, { method: 'POST', headers: this.headers(), body: JSON.stringify(body) });
        if (res.ok) return true;
        if (res.status < 500) {
          this.deps.log(`The hub refused ${path}: ${res.status} ${await res.text().catch(() => '')}`.trim());
          return false;
        }
      } catch {
        // try again
      }
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
    this.deps.log(`Could not reach the hub for ${path}.`);
    return false;
  }

  async snapshot(): Promise<Snapshot | null> {
    try {
      const res = await this.deps.fetch(`${this.deps.hubUrl}/api/state`);
      if (!res.ok) return null;
      const snapshot = Snapshot.parse(await res.json());
      this.suppliersCache = snapshot.suppliers;
      return snapshot;
    } catch {
      return null;
    }
  }

  async supplier(id: string): Promise<Supplier | null> {
    const cached = this.suppliersCache?.find((s) => s.id === id);
    if (cached) return cached;
    return (await this.snapshot())?.suppliers.find((s) => s.id === id) ?? null;
  }
}
