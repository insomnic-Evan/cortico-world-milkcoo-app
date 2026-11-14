import { createHash } from 'node:crypto';
import { MobileError } from './store.mjs';

const paths = new Set(['/native/capabilities', '/native/capture', '/native/media', '/native/tts', '/native/notification', '/native/audio']);
const canonical = value => JSON.stringify(value, (_k, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
/** Durable, targeted device operations. A claimed operation is never automatically executed again. */
export class NativeDeviceChannel {
  mediaKey(device, id) { return 'native-' + createHash('sha256').update(JSON.stringify([device, id])).digest('hex'); }
  media(device, id) { return this.store.getMedia(this.mediaKey(device, id)); }
  constructor(store) {
    this.store = store; this.db = store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS native_devices(device_id TEXT PRIMARY KEY, capabilities TEXT, seen_at TEXT);
      CREATE TABLE IF NOT EXISTS native_operations(operation_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, world_id TEXT NOT NULL,
        path TEXT NOT NULL, args TEXT NOT NULL, state TEXT NOT NULL, result TEXT, created_at TEXT NOT NULL);`);
  }
  enqueue(input) {
    const { operation_id, device_id, world_id, path, args = {} } = input;
    if (![operation_id, device_id, world_id].every(v => typeof v === 'string' && v.length && v.length <= 200) || !paths.has(path)) throw new MobileError('INVALID_NATIVE_OPERATION');
    const encoded = canonical(args), prior = this.row(operation_id);
    if (prior) {
      if (prior.device_id !== device_id || prior.world_id !== world_id || prior.path !== path || canonical(prior.args) !== encoded) throw new MobileError('NATIVE_OPERATION_CONFLICT', 409);
      return prior;
    }
    this.db.prepare('INSERT INTO native_operations VALUES(?,?,?,?,?,?,?,?)').run(operation_id, device_id, world_id, path, encoded, 'queued', null, new Date().toISOString());
    return this.row(operation_id);
  }
  row(id) {
    const row = this.db.prepare('SELECT * FROM native_operations WHERE operation_id=?').get(id);
    return row ? { ...row, args: JSON.parse(row.args), result: row.result ? JSON.parse(row.result) : null } : null;
  }
  poll({ device_id, capabilities }) {
    if (typeof device_id !== 'string' || !device_id) throw new MobileError('INVALID_DEVICE');
    this.db.prepare('INSERT OR REPLACE INTO native_devices VALUES(?,?,?)').run(device_id, JSON.stringify(capabilities ?? {}), new Date().toISOString());
    return this.store.transaction(() => {
      // Claimed operations are returned so Android can resend its durable receipt, never redo the action.
      const rows = this.db.prepare("SELECT operation_id FROM native_operations WHERE device_id=? AND result IS NULL AND state IN ('queued','claimed') ORDER BY created_at LIMIT 4").all(device_id);
      for (const row of rows) this.db.prepare("UPDATE native_operations SET state='claimed' WHERE operation_id=? AND state='queued'").run(row.operation_id);
      return { operations: rows.map(row => this.row(row.operation_id)) };
    });
  }
  complete({ device_id, operation_id, result, media }) {
    const prior = this.row(operation_id);
    if (!prior || prior.device_id !== device_id) throw new MobileError('NATIVE_OPERATION_NOT_FOUND', 404);
    if (!result || !['succeeded', 'needs_permission', 'unavailable', 'unknown', 'queued', 'posted', 'requested', 'rejected', 'speaking', 'ready', 'initializing', 'playback_error', 'not_started'].includes(result.state)) throw new MobileError('INVALID_NATIVE_RESULT');
    if (prior.result) {
      if (canonical(prior.result) !== canonical(result)) throw new MobileError('NATIVE_RESULT_CONFLICT', 409);
      return prior;
    }
    if (media?.data && result.media_id) {
      const bytes = Buffer.from(media.data, 'base64');
      if (bytes.length > 8 * 1024 * 1024 || createHash('sha256').update(bytes).digest('hex') !== result.media_id) throw new MobileError('INVALID_NATIVE_MEDIA');
      this.store.putMedia(this.mediaKey(device_id, result.media_id), device_id, media.mime, result.media_id, bytes);
    }
    if (result.state === 'succeeded' && result.media_id && !this.media(device_id, result.media_id)) throw new MobileError('NATIVE_MEDIA_MISSING', 409);
    this.db.prepare('UPDATE native_operations SET state=?,result=? WHERE operation_id=?').run(result.state, JSON.stringify(result), operation_id);
    return this.row(operation_id);
  }
  devices() { return this.db.prepare('SELECT * FROM native_devices').all().map(row => ({ ...row, capabilities: JSON.parse(row.capabilities) })); }
}
