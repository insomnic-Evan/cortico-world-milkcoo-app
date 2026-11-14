import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
const moduleUrl = process.env.STICKER_BRIDGE_PATH ? pathToFileURL(resolve(process.env.STICKER_BRIDGE_PATH)) : new URL('../src/sticker-bridge.mjs', import.meta.url);
const { SharedStickerLibrary } = await import(moduleUrl);
const { TinaMobileWorld } = await import('../src/world.mjs');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'coodock-sticker-ownership-')), dataDir = join(root, 'data');
  fs.mkdirSync(dataDir);
  t.after(() => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.match(basename(root), /^coodock-sticker-ownership-/);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, dataDir, ownDir: join(dataDir, 'milkcoo_app', 'stickers') };
}
function foreignLibraries(root, dataDir) {
  const files = [];
  for (const dir of [root, dataDir, join(root, 'qq'), join(root, 'qqbot'), join(dataDir, 'qq'), join(dataDir, 'qqbot')]) {
    fs.mkdirSync(dir, { recursive: true });
    const index = join(dir, 'sticker-index.json');
    fs.writeFileSync(index, JSON.stringify({ foreign: { hash: 'foreign', file: 'foreign.png', label: 'QQ owns this' } }));
    files.push(index);
    for (const name of ['emoji', 'stickers']) {
      const folder = join(dir, name); fs.mkdirSync(folder); const file = join(folder, 'foreign.png');
      fs.writeFileSync(file, png); files.push(file);
    }
  }
  return files;
}

test('startup, upload, duplicate updates and group save never read or write another World library', t => {
  const { root, dataDir, ownDir } = fixture(t), foreign = foreignLibraries(root, dataDir);
  const before = foreign.map(path => [path, fs.readFileSync(path), fs.statSync(path).mtimeMs]);
  const calls = [], original = {};
  const within = path => { const rel = relative(ownDir, String(path)); return rel !== '..' && !rel.startsWith('..'+(process.platform==='win32'?'\\':'/')) && !isAbsolute(rel); };
  const legacy = join(dataDir, 'milkcoo_app', 'sticker-index.json');
  for (const method of ['readFileSync', 'readdirSync', 'writeFileSync', 'renameSync']) {
    original[method] = fs[method];
    fs[method] = (...args) => { calls.push({ method, path: String(args[0]) }); return original[method](...args); };
  }
  syncBuiltinESMExports();
  let lib;
  try {
    lib = new SharedStickerLibrary({ dataDir });
    assert.equal(lib.list().length, 0, 'foreign metadata and images are not auto-imported');
    const saved = lib.addFromPhone({ bytes: png, mime: 'image/png', label: 'phone' });
    lib.addFromPhone({ bytes: png, mime: 'image/png', label: 'phone update' });
    lib.addFromGroup({ bytes: png, mime: 'image/png' });
    lib.addFromGroup({ bytes: png, mime: 'image/png' });
    assert.equal(lib.list().length, 1);
    assert.deepEqual(lib.readLibrarySticker(saved.file).bytes, png);
  } finally {
    for (const [method, value] of Object.entries(original)) fs[method] = value;
    syncBuiltinESMExports();
  }
  assert.ok(calls.every(({method,path}) => within(path) || method==='readFileSync' && path===legacy), JSON.stringify(calls));
  assert.equal(lib.ownIndex, join(ownDir, 'sticker-index.json'));
  for (const [path, bytes, mtime] of before) { assert.deepEqual(fs.readFileSync(path), bytes); assert.equal(fs.statSync(path).mtimeMs, mtime); }
  for (const path of foreign.filter(x=>x.endsWith('foreign.png'))) assert.deepEqual(fs.readdirSync(dirname(path)), ['foreign.png']);
});

test('legacy CooDock metadata migrates read-only, retaining labels and ignoring missing foreign image references', t => {
  const { dataDir, ownDir } = fixture(t); fs.mkdirSync(ownDir, { recursive: true });
  fs.writeFileSync(join(ownDir, 'mine.png'), png);
  const legacy = join(dataDir, 'milkcoo_app', 'sticker-index.json');
  fs.writeFileSync(legacy, JSON.stringify({ [hash(png)]: {hash:hash(png),file:'mine.png',label:'existing label',sources:['coodock-world-chat'],count:4},
    foreign:{hash:'foreign',file:'only-in-qq.png',label:'not ours'} }));
  const before = fs.readFileSync(legacy), lib = new SharedStickerLibrary({ dataDir });
  assert.equal(lib.list().length, 1); assert.equal(lib.list()[0].label, 'existing label');
  lib.addFromGroup({bytes:png,mime:'image/png'});
  assert.equal(lib.list()[0].count, 4, 'repeated public-room saves remain idempotent');
  assert.deepEqual(fs.readFileSync(legacy), before);
  assert.ok(fs.existsSync(join(ownDir,'sticker-index.json')));
  assert.equal(new SharedStickerLibrary({dataDir}).list()[0].label, 'existing label');
});

test('old foreign filename entries cannot read outside this library', t => {
  const { root, dataDir } = fixture(t); foreignLibraries(root,dataDir);
  const lib=new SharedStickerLibrary({dataDir});
  for(const name of ['foreign.png','../emoji/foreign.png','..\\emoji\\foreign.png',join(root,'emoji','foreign.png')]) {
    assert.equal(lib.readStickerFile(name),null);assert.equal(lib.readLibrarySticker(name),null);
  }
});

test('an index write failure is reported instead of returning a false saved receipt', t => {
  const {dataDir}=fixture(t),lib=new SharedStickerLibrary({dataDir});fs.mkdirSync(lib.ownIndex);
  assert.throws(()=>lib.addFromPhone({bytes:png,mime:'image/png'}));
});

test('phone HTTP upload, list and download use the owned library and survive restart', async t => {
  const {root,dataDir}=fixture(t);const foreign=foreignLibraries(root,dataDir),before=foreign.map(path=>fs.readFileSync(path));
  const context={dataDir,botDir:dataDir,cfg:{host:'127.0.0.1',port:0,tokenSecret:'FIXTURE'},secret:()=> 'fixture'};
  const host={store:{latestCursor:()=>0,range:()=>[]},pushEvent:async()=>({cursor:1})};
  const world=new TinaMobileWorld(context);await world.start(host);t.after(()=>world.stop());
  const req=async(path,body)=> {
    const response=await fetch('http://127.0.0.1:'+world.address().port+path,{method:body?'POST':'GET',
      headers:{authorization:'Bearer fixture','content-type':'application/json'},body:body?JSON.stringify(body):undefined});
    assert.equal(response.status,200);return response.json();
  };
  const receipt=await req('/v1/stickers',{mime:'image/png',data:png.toString('base64'),label:'owned phone sticker'});
  assert.equal((await req('/v1/stickers')).total,1);
  const downloaded=await req('/v1/stickers/file?name='+encodeURIComponent(receipt.sticker.file));
  assert.deepEqual(Buffer.from(downloaded.data,'base64'),png);
  await world.stop();const reopened=new SharedStickerLibrary({dataDir});assert.equal(reopened.list()[0].label,'owned phone sticker');
  foreign.forEach((path,i)=>assert.deepEqual(fs.readFileSync(path),before[i]));
});
