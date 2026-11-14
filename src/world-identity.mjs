import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const WORLD_ID = 'milkcoo-app';
export const LEGACY_WORLD_ID = 'milkcoo_app';
export const WORLD_LABEL = '移动前端coodock';

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function readObject(path) {
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const text = bytes[0] === 0xff && bytes[1] === 0xfe
    ? bytes.subarray(2).toString('utf16le')
    : bytes.toString('utf8').replace(/^\uFEFF/u, '');
  const value = JSON.parse(text);
  if (!isRecord(value)) throw new Error('Expected a JSON object');
  return value;
}

function validateConfig(value) {
  if (Array.isArray(value)) {
    value.forEach(validateConfig);
  } else if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Unsafe configuration key');
      validateConfig(child);
    }
  }
}

function assertNoOtherOwner(dataDir) {
  const lock = readObject(join(dataDir, 'instance.lock'));
  if (lock === null || lock.pid === process.pid) return;
  if (!Number.isSafeInteger(lock.pid) || lock.pid <= 0) throw new Error('Invalid instance lock');
  try {
    process.kill(lock.pid, 0);
  } catch (error) {
    if (error.code === 'ESRCH') return;
    throw error;
  }
  throw new Error('Another process owns the deployment');
}

function migrateVisibility(dataDir) {
  const path = join(dataDir, 'core-state.json');
  const state = readObject(path);
  const visibility = state?.worldVisibility;
  if (visibility === undefined) return;
  if (!isRecord(visibility)) throw new Error('Invalid World visibility state');
  if (!Object.hasOwn(visibility, LEGACY_WORLD_ID) || Object.hasOwn(visibility, WORLD_ID)) return;
  visibility[WORLD_ID] = visibility[LEGACY_WORLD_ID] !== false;
  const temporary = path + '.coodock-' + randomUUID();
  try {
    writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  if (readObject(path)?.worldVisibility?.[WORLD_ID] !== visibility[WORLD_ID]) throw new Error('Visibility readback failed');
}

function pathInfo(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function isDirectoryOrMissing(path) {
  const info = pathInfo(path);
  if (info === null) return false;
  if (!info.isDirectory()) throw new Error('Expected a deployment directory');
  return true;
}

function migrateEnvPrompt(botDir) {
  const worlds = join(botDir, 'worlds');
  const oldDir = join(worlds, LEGACY_WORLD_ID);
  const newDir = join(worlds, WORLD_ID);
  if (!isDirectoryOrMissing(worlds) || !isDirectoryOrMissing(oldDir)) return;
  const source = join(oldDir, 'ENV_PROMPT.md');
  const target = join(newDir, 'ENV_PROMPT.md');
  const newDirectoryExists = isDirectoryOrMissing(newDir);
  if (newDirectoryExists && pathInfo(target)) return;
  const original = pathInfo(source);
  if (original === null) return;
  if (!original.isFile()) throw new Error('Expected a deployment prompt file');
  const contents = readFileSync(source);
  if (!newDirectoryExists) {
    try {
      mkdirSync(newDir, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST' || !isDirectoryOrMissing(newDir)) throw error;
    }
  }

  const temporary = target + '.coodock-' + randomUUID();
  try {
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(fd, contents);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // The temporary file is complete before it is published. Linking gives the
    // filesystem an atomic no-replacement operation if the user created a new override.
    try {
      linkSync(temporary, target);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** On the first upgrade, copy the legacy settings while leaving rollback data intact. */
export function migrateWorldIdentity(context) {
  if (context?.id !== WORLD_ID || !context.botDir || !context.dataDir || typeof context.persist !== 'function') return;
  const configPath = join(context.botDir, 'config.json');
  try {
    const worlds = readObject(configPath)?.worlds;
    if (!isRecord(worlds) || !Object.hasOwn(worlds, LEGACY_WORLD_ID) || Object.hasOwn(worlds, WORLD_ID)) return;
    const legacy = worlds[LEGACY_WORLD_ID];
    if (!isRecord(legacy)) throw new Error('Invalid legacy World configuration');
    validateConfig(legacy);
    assertNoOtherOwner(context.dataDir);
    migrateVisibility(context.dataDir);
    assertNoOtherOwner(context.dataDir);
    const current = readObject(configPath)?.worlds;
    if (!isRecord(current) || Object.hasOwn(current, WORLD_ID)) return;
    if (JSON.stringify(current[LEGACY_WORLD_ID]) !== JSON.stringify(legacy)) throw new Error('Legacy configuration changed during migration');
    migrateEnvPrompt(context.botDir);
    context.persist(legacy);
    if (!isRecord(readObject(configPath)?.worlds?.[WORLD_ID])) throw new Error('World configuration readback failed');
  } catch {
    throw new Error('移动前端coodock：旧配置、可见性或提示词未能安全迁移，请先关闭此部署的其他实例并检查文件。');
  }
}
