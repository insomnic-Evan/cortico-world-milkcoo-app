import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, lstatSync, openSync, closeSync, fsyncSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { atomicJson } from './journal.mjs';

export const CHECKPOINT_FORMAT = 'tina-cortico-checkpoint/1';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function buildCheckpoint(deployment) {
  const folder = resolve(deployment), session = join(folder, 'data/session-main.jsonl');
  const initial = readFileSync(session), files = [];
  function walk(dir, prefix = '') {
    for (const name of readdirSync(dir).sort()) {
      if (name === '.git') continue;
      const path = join(dir, name), key = prefix + name, stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error('Checkpoint workspace contains a symlink');
      if (stat.isDirectory()) walk(path, key + '/');
      else if (stat.isFile()) {
        const bytes = readFileSync(path);
        files.push({ path: key, bytes: bytes.length, sha256: sha256(bytes), data: bytes.toString('base64'), mtimeMs: stat.mtimeMs });
      }
    }
  }
  walk(join(folder, 'workspace'));
  if (!initial.equals(readFileSync(session))) throw new Error('Checkpoint session changed during capture');
  for (const file of files) {
    const stat = statSync(join(folder, 'workspace', file.path));
    if (stat.size !== file.bytes || stat.mtimeMs !== file.mtimeMs) throw new Error('Checkpoint workspace changed during capture');
  }
  // Exact source bytes stay in the checkpoint; parsing is only a working view.
  const rows = initial.toString('utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
  if (!rows.some(row => row.item?.type === 'message' && row.item.role === 'system')) throw new Error('Checkpoint lacks its actual system');
  const cfg = JSON.parse(readFileSync(join(folder, 'config.json'), 'utf8'));
  const basis = { session_sha256: sha256(initial), files: files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })) };
  return { format: CHECKPOINT_FORMAT, revision: sha256(JSON.stringify(basis)), createdAt: new Date().toISOString(),
    deployment: folder.split(/[\\/]/).at(-1), provider: cfg.activeProvider ?? null, consistency: 'observed-stable-file-set',
    session: { sha256: basis.session_sha256, data: initial.toString('base64'), records: rows.length }, files };
}
export function validateCheckpoint(value) {
  if (value?.format !== CHECKPOINT_FORMAT || !Array.isArray(value.files)) throw new Error('Unsupported Cortico checkpoint');
  const bytes = Buffer.from(value.session?.data ?? '', 'base64');
  if (sha256(bytes) !== value.session?.sha256) throw new Error('Checkpoint session hash mismatch');
  const seen = new Set();
  for (const file of value.files) {
    if (typeof file.path !== 'string' || !file.path || file.path.startsWith('/') || file.path.includes('\\')
      || file.path.split('/').some(part => !part || part === '..' || part === '.') || seen.has(file.path)) throw new Error('Invalid checkpoint path');
    seen.add(file.path);
    const data = Buffer.from(file.data, 'base64');
    if (data.length !== file.bytes || sha256(data) !== file.sha256) throw new Error('Checkpoint file hash mismatch');
  }
  const basis = { session_sha256: value.session.sha256, files: value.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })) };
  if (sha256(JSON.stringify(basis)) !== value.revision) throw new Error('Checkpoint revision mismatch');
  const records = bytes.toString('utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
  if (!records.some(row => row.item?.role === 'system')) throw new Error('Checkpoint lacks system');
  return { checkpoint: value, records };
}
export class CheckpointStore {
  constructor(directory) { this.directory = join(directory, 'computer-checkpoints'); this.objects = join(this.directory, 'objects'); mkdirSync(this.objects, { recursive: true }); this.loaded = new Map(); }
  currentRevision() { const p = join(this.directory, 'current.json'); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')).revision : null; }
  put(value) {
    const result = validateCheckpoint(value), path = join(this.directory, value.revision + '.json');
    const put = (hash, data) => {
      const target = join(this.objects, hash + '.gz');
      if (!existsSync(target)) {
        const bytes = Buffer.from(data, 'base64'), temp = target + '.new'; writeFileSync(temp, gzipSync(bytes), { mode: 0o600 });
        const fd = openSync(temp, 'r+'); try { fsyncSync(fd); } finally { closeSync(fd); }
        if (sha256(gunzipSync(readFileSync(temp))) !== hash) throw new Error('Backup object readback mismatch'); renameSync(temp, target);
      }
    };
    put(value.session.sha256, value.session.data); for (const file of value.files) put(file.sha256, file.data);
    if (!existsSync(path)) atomicJson(path, { ...value, session: { ...value.session, data: undefined }, files: value.files.map(({ data, ...file }) => file) });
    atomicJson(join(this.directory, 'current.json'), { revision: value.revision, createdAt: value.createdAt, deployment: value.deployment });
    this.loaded.clear(); this.loaded.set(value.revision, result); return result;
  }
  read(revision = this.currentRevision()) {
    if (!revision || !/^[a-f0-9]{64}$/.test(revision)) return null;
    if (!this.loaded.has(revision)) {
      const path = join(this.directory, revision + '.json'), legacy = join(this.directory, revision + '.json.gz');
      let value;
      if (existsSync(path)) {
        value = JSON.parse(readFileSync(path, 'utf8'));
        const read = hash => gunzipSync(readFileSync(join(this.objects, hash + '.gz'))).toString('base64');
        value.session.data = read(value.session.sha256); for (const file of value.files) file.data = read(file.sha256);
      } else if (existsSync(legacy)) value = JSON.parse(gunzipSync(readFileSync(legacy)));
      else return null;
      this.loaded.set(revision, validateCheckpoint(value));
      while (this.loaded.size > 2) this.loaded.delete(this.loaded.keys().next().value);
    }
    return this.loaded.get(revision);
  }
}
