// Explicitly requested downloads only. These digests are from the GitHub release
// assets API for EasyTier/EasyTier v2.6.4, not dynamically trusted metadata.
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, open, rm } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';

export const EASYTIER_ASSETS = Object.freeze({
  windows: { name: 'easytier-gui_2.6.4_x64-setup.exe', size: 10942975, sha256: '0f92d378658fe5b5b150f6dbd06c0069b7e9c10e2dc127bcac6149f5185b5678' },
  android: { name: 'app-arm64-release.apk', size: 31389594, sha256: '53444ada74838e91504ae8d3ee2688bc91ee9cf43f36b969c07de6af696f723c' },
});
const base = 'https://github.com/EasyTier/EasyTier/releases/download/v2.6.4/';
export async function fetchEasyTierAsset(kind, directory, options = {}) {
  const asset = (options.assets ?? EASYTIER_ASSETS)[kind];
  if (!asset) throw new Error('UNKNOWN_ASSET');
  await mkdir(directory, { recursive: true });
  const target = join(directory, asset.name);
  // Never overwrite a file. Existing bytes must match before being reported as verified.
  try {
    const handle = await open(target, 'r');
    let size = 0; const digest = createHash('sha256');
    try { for await (const chunk of handle.createReadStream({ autoClose: false })) { size += chunk.length; digest.update(chunk); } }
    finally { await handle.close(); }
    if (size !== asset.size || digest.digest('hex') !== asset.sha256) throw new Error('EXISTING_FILE_HASH_MISMATCH');
    return { file: target, state: 'verified-existing' };
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const tmp = join(directory, `.${asset.name}.${randomBytes(8).toString('hex')}.part`);
  try {
    const response = await (options.fetch ?? fetch)(base + asset.name, { signal: AbortSignal.timeout(180000) });
    if (!response.ok || !response.body) throw new Error(`DOWNLOAD_HTTP_${response.status}`);
    let size = 0; const digest = createHash('sha256');
    const check = new Transform({ transform(chunk, encoding, done) {
      size += chunk.length;
      if (size > asset.size) return done(new Error('DOWNLOAD_SIZE_MISMATCH'));
      digest.update(chunk); done(null, chunk);
    } });
    await pipeline(Readable.fromWeb(response.body), check, createWriteStream(tmp, { flags: 'wx' }));
    if (size !== asset.size || digest.digest('hex') !== asset.sha256) throw new Error('DOWNLOAD_HASH_MISMATCH');
    // Hard link fails rather than overwriting a target created by another download.
    const { link } = await import('node:fs/promises');
    await link(tmp, target);
    return { file: target, state: 'verified-new' };
  } finally { await rm(tmp, { force: true }); }
}
