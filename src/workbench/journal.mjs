import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const text = JSON.stringify(value, null, 2) + '\n';
  const temporary = path + '.new';
  writeFileSync(temporary, text, { mode: 0o600 });
  const fd = openSync(temporary, 'r+');
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
  if (readFileSync(path, 'utf8') !== text) throw new Error('Configuration read-back mismatch');
}

/** Append-only source records; projections are reconstructed and never overwrite originals. */
export class HostJournal {
  constructor(directory) {
    mkdirSync(directory, { recursive: true });
    this.path = join(directory, 'mobile-journal.jsonl');
    this.records = [];
    this.messages = new Map();
    this.events = new Map();
    this.logs = [];
    this.sequence = 0;
    if (existsSync(this.path)) {
      const bytes = readFileSync(this.path, 'utf8');
      const lines = bytes.split('\n');
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index].trim();
        if (!line) continue;
        let record;
        try { record = JSON.parse(line); }
        catch (error) {
          // Preserve a torn source for inspection; do not concatenate the next record onto it.
          if (index === lines.length - 1) {
            writeFileSync(this.path + `.torn-${Date.now()}`, line, { mode: 0o600 });
            const valid = lines.slice(0, index).join('\n') + '\n';
            writeFileSync(this.path, valid, { mode: 0o600 });
            break;
          }
          throw new Error(`Unreadable journal record ${index + 1}`);
        }
        this.apply(record);
      }
    }
  }
  append(kind, value) {
    const { seq: ignoredSequence, kind: ignoredKind, ...content } = value;
    const record = { ...content, seq: this.sequence + 1, kind, ts: content.ts ?? new Date().toISOString() };
    const fd = openSync(this.path, 'a', 0o600);
    try { appendFileSync(fd, JSON.stringify(record) + '\n'); fsyncSync(fd); }
    finally { closeSync(fd); }
    this.apply(record);
    return record;
  }
  apply(record) {
    this.sequence = Math.max(this.sequence, record.seq ?? 0);
    this.records.push(record);
    if (record.kind === 'message') this.messages.set(record.id, { ...record });
    if (record.kind === 'message.update') {
      const current = this.messages.get(record.id);
      if (current) Object.assign(current, record.patch);
    }
    if (record.kind === 'event') this.events.set(record.id, { ...record });
    if (record.kind === 'event.update') {
      const current = this.events.get(record.id);
      if (current) Object.assign(current, record.patch);
    }
    if (record.kind === 'log') {
      this.logs.push({ level: record.level, text: record.text, ts: record.ts });
      if (this.logs.length > 300) this.logs.shift();
    }
  }
}
