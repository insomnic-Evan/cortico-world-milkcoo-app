import { MobileError } from './store.mjs';
import { readPetResource } from './pet-resources.mjs';
import { isDeepStrictEqual } from 'node:util';

const jsonResource = async (port, path) => JSON.parse((await readPetResource(port, path)).bytes.toString('utf8'));
export async function wardrobeState(port) {
  const [state, figures] = await Promise.all([jsonResource(port, '/api/state'), jsonResource(port, '/api/figures')]);
  return { state, figures, scope: 'connected-coo', position_scope: 'device-local' };
}
export function selectedSkin(pack, picks, previous = {}) {
  const axes = pack.axes ?? [];
  for (const axis of axes) if (!(axis.options ?? []).some(option => option.id === picks[axis.id])) throw new MobileError('PET_OPTION_INVALID');
  if (Object.keys(picks).some(id => !axes.some(a => a.id === id))) throw new MobileError('PET_OPTION_INVALID');
  if (pack.id === 'coo') return { ...previous, figure: pack.id, ...picks };
  const preset = (pack.presets ?? []).find(p => axes.every(a => p.pick?.[a.id] === picks[a.id]));
  return { ...previous, figure: pack.id, scheme: preset?.id ?? axes.map(a => picks[a.id]).join('-') };
}
async function write(port, path, body, contentType = 'application/json') {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', redirect: 'manual',
    headers: { 'content-type': contentType }, body: Buffer.isBuffer(body) ? body : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new MobileError('PET_OPERATION_UNAVAILABLE', response.status === 404 ? 404 : 502);
  if (value.error) throw new MobileError('PET_OPERATION_FAILED');
  return value;
}
export async function changeWardrobe(port, input) {
  const before = await wardrobeState(port);
  if (input.expected && !isDeepStrictEqual(input.expected, before.state.skin)) throw new MobileError('PET_CHANGED_REFRESH', 409);
  const pack = before.figures.find(p => p.id === input.figure);
  if (!pack) throw new MobileError('PET_FIGURE_NOT_INSTALLED', 404);
  const skin = selectedSkin(pack, input.picks ?? {}, before.state.skin);
  await write(port, '/api/skin', { skin });
  const result = await wardrobeState(port), actual = result.state.skin;
  const applied = actual?.figure === skin.figure && (pack.id === 'coo'
    ? Object.entries(input.picks ?? {}).every(([key, value]) => actual[key] === value)
    : actual.scheme === skin.scheme);
  if (!applied) throw new MobileError('PET_READBACK_MISMATCH', 502);
  return result;
}
export async function figureOperation(port, path, body) {
  if (!['/api/figures/import/install', '/api/figures/import/cancel', '/api/figures/remove'].includes(path)) throw new MobileError('PET_OPERATION_INVALID');
  return write(port, path, body);
}
export async function importFigureZip(port, req) {
  const chunks = []; let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 128 * 1024 * 1024) throw new MobileError('PET_IMPORT_TOO_LARGE', 413);
    chunks.push(chunk);
  }
  return write(port, '/api/figures/import', Buffer.concat(chunks), 'application/zip');
}
