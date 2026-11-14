import { lstat, readdir, readFile, mkdtemp, unlink, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import { crc32, deflateRawSync } from 'node:zlib';

const LIMIT = 256 * 1024 * 1024;
const excluded = new Set(['runs', 'media', 'instance.lock', 'session-main.jsonl', '.session-archive-shadow.jsonl']);
const payload = /\.(wav|pcm|mp3|flac|m4a|ogg|opus|mp4|png|jpg|jpeg|onnx)$/i;

// A small, standard ZIP writer. No platform tools or extra runtime dependencies are needed.
function zip(files) {
  if (files.length > 65535) throw new Error('配置备份文件过多');
  const chunks = [], directory = []; let offset = 0;
  for (const { name, data } of files) {
    const path = Buffer.from(name), bytes = deflateRawSync(data), crc = crc32(data);
    const header = Buffer.alloc(30), central = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(8, 8); header.writeUInt16LE(33, 12); header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(path.length, 26);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8); central.writeUInt16LE(8, 10); central.writeUInt16LE(33, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(path.length, 28); central.writeUInt32LE(offset, 42);
    chunks.push(header, path, bytes); directory.push(central, path); offset += header.length + path.length + bytes.length;
  }
  const end = Buffer.alloc(22), index = Buffer.concat(directory);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(index.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, index, end]);
}

/** Capture configuration/state. Each live SQLite database uses its online backup API. */
export async function captureBackup(deployment, runtime) {
  const stage = await mkdtemp(join(tmpdir(), 'coo-db-backup-')), entries = [], files = []; let total = 0;
  async function add(path, name) {
    const before = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!before || before.isSymbolicLink()) return;
    if (before.isDirectory()) {
      for (const child of (await readdir(path)).sort()) {
        if (!['node_modules', '.git', '__pycache__'].includes(child)) await add(join(path, child), name + '/' + child);
      }
      return;
    }
    if (!before.isFile() || (name.startsWith('deployment/data/') && payload.test(name))) return;
    if (total + before.size > LIMIT) throw new Error('配置备份超过 256 MiB');
    let data, method;
    if (/\.(sqlite|db)$/i.test(path)) {
      const target = join(stage, entries.length + '.sqlite'), source = new DatabaseSync(path, { readOnly: true });
      try { await backup(source, target); data = await readFile(target); method = 'sqlite-online-backup'; }
      finally { source.close(); await unlink(target).catch(() => {}); }
    } else {
      data = await readFile(path); const after = await lstat(path);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('配置在备份期间发生变化，请稍后重试');
      method = 'observed-stable-file';
    }
    if (total + data.length > LIMIT) throw new Error('配置备份超过 256 MiB');
    total += data.length; files.push({ name, data });
    entries.push({ path: name, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex'), method });
  }
  try {
    for (const name of ['config.json', 'deployment.json', '.env']) await add(join(deployment, name), 'deployment/' + name);
    const data = join(deployment, 'data');
    for (const name of (await readdir(data).catch(error => { if (error.code === 'ENOENT') return []; throw error; })).sort()) {
      if (!excluded.has(name) && !name.endsWith('-wal') && !name.endsWith('-shm')) await add(join(data, name), 'deployment/data/' + name);
    }
    for (const name of ['providers', 'private/providers', 'packages', 'extensions']) await add(join(runtime, name), 'runtime/' + name);
    const manifest = { format: 'tina-deployment-archive/1', files: entries, source_bytes: total,
      scope: 'configuration and state; conversation and workspace travel in the separate checkpoint',
      excluded: ['node_modules', '.git', 'runs', 'media', 'session-main.jsonl', '.session-archive-shadow.jsonl', 'workspace (separate checkpoint)', 'audio/image/model payloads in data', 'process locks', 'WAL/SHM sidecars'],
      restore: 'restore disabled; reconcile device roles and reinstall dependencies before activation' };
    files.push({ name: 'SNAPSHOT-MANIFEST.json', data: Buffer.from(JSON.stringify(manifest)) });
    const bytes = zip(files); return { bytes, details: { files: entries.length, source_bytes: total, archive_bytes: bytes.length } };
  } finally { await rmdir(stage).catch(() => {}); }
}
