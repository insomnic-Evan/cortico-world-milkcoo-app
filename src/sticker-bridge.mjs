import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, renameSync, lstatSync } from 'node:fs';
import { join, extname } from 'node:path';

/**
 * Sticker library shared by this World, its phone clients and its public-room tools.
 * - Uses content-addressed `sticker-<sha256_16>.<ext>` filenames and `sticker-index.json` metadata.
 * - Owns only milkcoo_app/stickers; never discovers another World's files.
 * - Other libraries exchange stickers explicitly through their own import/export interfaces.
 * - In private phone dialogue, stickers travel as semantic `[表情包:文件名]` text tokens.
 */
export class SharedStickerLibrary {
  constructor(context) {
    this.context = context;
    const baseDataDir = context?.dataDir ?? '.';
    this.ownDir = join(baseDataDir, 'milkcoo_app', 'stickers');
    this.ownIndex = join(this.ownDir, 'sticker-index.json');
    // Read-only compatibility with our own earlier layout; never a QQ/other-World index.
    this.legacyOwnIndex = join(baseDataDir, 'milkcoo_app', 'sticker-index.json');
    mkdirSync(this.ownDir, { recursive: true });
    this.meta = new Map();
    this.load();
  }

  load() {
    for (const idx of [existsSync(this.ownIndex) ? this.ownIndex : this.legacyOwnIndex]) {
      if (!existsSync(idx)) continue;
      try {
        const raw = JSON.parse(readFileSync(idx, 'utf8'));
        for (const [k, v] of Object.entries(raw)) {
          if (v && typeof v === 'object' && this.findFile(v.file)) {
            this.meta.set(v.hash || k, v);
          }
        }
      } catch {}
    }
    // Index loose image files inside our own library only.
    for (const dir of [this.ownDir]) {
      if (!existsSync(dir)) continue;
      try {
        for (const f of readdirSync(dir)) {
          if (!this.findFile(f)) continue;
          const already = [...this.meta.values()].some(m => m.file === f);
          if (!already) {
            const bytes = readFileSync(join(dir, f));
            const hash = createHash('sha256').update(bytes).digest('hex');
            if (!this.meta.has(hash)) {
              const ext = extname(f).toLowerCase() || '.gif';
              this.meta.set(hash, {
                hash,
                ext,
                file: f,
                summary: '',
                emotion: '常用',
                usage: '日常互动',
                tag: f.replace(/\.[^.]+$/, '').slice(0, 12),
                label: f.replace(/\.[^.]+$/, '').slice(0, 12),
                firstSeen: Date.now(),
                lastSeen: Date.now(),
                count: 1,
                sources: ['coo-host'],
              });
            }
          }
        }
      } catch {}
    }
  }

  save() {
    const obj = Object.fromEntries(this.meta);
    const json = JSON.stringify(obj, null, 2);
    writeFileSync(this.ownIndex + '.tmp', json, 'utf8');
    renameSync(this.ownIndex + '.tmp', this.ownIndex);
  }

  list(limit = 200) {
    this.load();
    return [...this.meta.values()]
      .sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0))
      .slice(0, limit);
  }

  stats(limit = 20) {
    const all = this.list(500);
    const byEmotion = {};
    for (const m of all) {
      const emo = m.emotion || '常用';
      byEmotion[emo] = (byEmotion[emo] ?? 0) + 1;
    }
    return { total: all.length, byEmotion, recent: all.slice(0, limit) };
  }

  findFile(fileName) {
    if (typeof fileName !== 'string' || fileName.length > 255 || !/^[^\\/\u0000-\u001f]+\.(?:gif|png|webp|jpe?g)$/i.test(fileName)) return null;
    const path = join(this.ownDir, fileName);
    try { if (lstatSync(path).isFile()) return path; } catch {}
    return null;
  }

  readStickerFile(fileName) {
    const path = this.findFile(fileName);
    if (!path) return null;
    const bytes = readFileSync(path);
    const ext = extname(path).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/jpeg';
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    return { file: String(fileName).replace(/[\\/]/g, ''), mime, sha256, bytes };
  }

  readLibrarySticker(fileName) {
    if (typeof fileName !== 'string' || fileName.length > 255 || !/^[^\\/\u0000-\u001f]+\.(?:gif|png|webp|jpe?g)$/i.test(fileName)) return null;
    this.load();
    return [...this.meta.values()].some(entry => entry.file === fileName) ? this.readStickerFile(fileName) : null;
  }

  addFromPhone(input) { return this.add(input, 'coodock-mobile'); }

  addFromGroup(input) {
    this.load();
    const entry = this.add(input, 'coodock-world-chat');
    try {
      const file = this.readStickerFile(entry.file);
      const index = JSON.parse(readFileSync(this.ownIndex, 'utf8'));
      if (file?.sha256 !== entry.hash || index[entry.hash]?.file !== entry.file) throw new Error();
    } catch { throw new Error('WORLD_CHAT_STICKER_SAVE_FAILED'); }
    return entry;
  }

  add({ bytes, mime = '', label = '', emotion = '常用', usage = '日常互动', tag = '' }, source) {
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const hash = createHash('sha256').update(buf).digest('hex');
    const existing = this.meta.get(hash);
    if (existing && this.readStickerFile(existing.file)?.sha256 === hash) {
      if (source === 'coodock-world-chat' && existing.sources?.includes(source)) {
        if (!existsSync(this.ownIndex)) this.save();
        return existing;
      }
      existing.count = (existing.count ?? 1) + 1;
      existing.lastSeen = Date.now();
      if (label && (!existing.label || existing.label === '表情包')) existing.label = label;
      if (emotion && existing.emotion === '未知') existing.emotion = emotion;
      if (usage && existing.usage === '未知') existing.usage = usage;
      if (tag && !existing.tag) existing.tag = tag;
      if (!existing.sources?.includes(source)) {
        existing.sources = [...(existing.sources ?? []), source];
      }
      this.save();
      return existing;
    }
    const ext = mime.includes('png') ? '.png' : mime.includes('webp') ? '.webp' : mime.includes('gif') ? '.gif' : '.jpg';
    const file = `sticker-${hash.slice(0, 16)}${ext}`;
    writeFileSync(join(this.ownDir, file), buf);
    const cleanLabel = String(label || tag || '表情包').trim();
    const entry = {
      hash,
      ext,
      file,
      summary: `[表情]${cleanLabel}`,
      emotion: String(emotion || '常用').trim(),
      usage: String(usage || '日常互动').trim(),
      tag: String(tag || cleanLabel).trim().slice(0, 8),
      label: cleanLabel,
      firstSeen: Date.now(),
      lastSeen: Date.now(),
      count: 1,
      sources: [source],
    };
    this.meta.set(hash, entry);
    this.save();
    return entry;
  }
}
