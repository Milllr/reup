// Recordings: every good run is saved, so the demo can replay it when the live web says no.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface Recording {
  kind: string;
  supplierId: string;
  /** What the run was about: the part for a price, the part and the quantity for a cart. A recording is only replayed for the same thing. */
  subject: string;
  savedAt: string;
  durationMs: number;
  /** When each step happened, in ms from the start of the run. */
  steps: { offsetMs: number; purpose: string }[];
  result: Record<string, unknown> | null;
}

export interface Recordings {
  save(recording: Recording): Promise<void>;
  load(kind: string, supplierId: string, subject: string): Promise<Recording | null>;
}

const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');

export function fileRecordings(dir: string): Recordings {
  const path = (kind: string, supplierId: string, subject: string) => join(dir, `${safe(kind)}-${safe(supplierId)}-${safe(subject)}.json`);
  return {
    async save(recording) {
      await mkdir(dir, { recursive: true });
      await writeFile(path(recording.kind, recording.supplierId, recording.subject), `${JSON.stringify(recording, null, 2)}\n`, 'utf8');
    },
    async load(kind, supplierId, subject) {
      try {
        const data = JSON.parse(await readFile(path(kind, supplierId, subject), 'utf8')) as Recording;
        return Array.isArray(data.steps) && data.subject === subject ? data : null;
      } catch {
        return null;
      }
    },
  };
}

export function memoryRecordings(): Recordings & { all: Map<string, Recording> } {
  const all = new Map<string, Recording>();
  return {
    all,
    save: async (r) => void all.set(`${r.kind}-${r.supplierId}-${r.subject}`, structuredClone(r)),
    load: async (kind, supplierId, subject) => structuredClone(all.get(`${kind}-${supplierId}-${subject}`) ?? null),
  };
}
