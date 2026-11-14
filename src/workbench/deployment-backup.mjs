import { createHash, randomBytes, hkdfSync, createCipheriv, createDecipheriv } from 'node:crypto';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { atomicJson } from './journal.mjs';

const key = (token, salt) => hkdfSync('sha256', token, Buffer.from(salt, 'base64'), 'tina-deployment-sealed/1', 32);
export function sealDeployment(bytes, token, details = {}) {
  const salt = randomBytes(32).toString('base64'), iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key(token, salt), iv);
  const data = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return { format: 'tina-deployment-sealed/1', createdAt: new Date().toISOString(), ...details,
    revision: createHash('sha256').update(bytes).digest('hex'), salt, iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}
export function verifyDeployment(value, token) {
  if (value?.format !== 'tina-deployment-sealed/1') throw new Error('Unknown deployment backup');
  const cipher = createDecipheriv('aes-256-gcm', key(token, value.salt), Buffer.from(value.iv, 'base64'));
  cipher.setAuthTag(Buffer.from(value.tag, 'base64'));
  const data = Buffer.concat([cipher.update(Buffer.from(value.data, 'base64')), cipher.final()]);
  if (createHash('sha256').update(data).digest('hex') !== value.revision) throw new Error('Deployment backup hash mismatch');
  return data;
}
export function storeDeployment(directory, value, token) {
  verifyDeployment(value, token);
  const path = join(directory, 'deployment-backups', value.revision + '.sealed.json');
  if (!existsSync(path)) atomicJson(path, value);
  verifyDeployment(JSON.parse(readFileSync(path, 'utf8')), token);
  const state = { revision: value.revision, at: value.createdAt, files: value.files, source_bytes: value.source_bytes, encrypted: true };
  atomicJson(join(directory, 'deployment-backups/current.json'), state); return state;
}
