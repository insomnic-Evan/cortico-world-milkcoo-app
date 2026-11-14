import { createHash } from 'node:crypto';
import { MobileError } from './store.mjs';

/** An actual Cortico tool call records an explicit, device-scoped control event. */
export async function requestPetInterrupt(host, source, botDir, input, call, pending) {
  if (call?.signal?.aborted) throw new MobileError('CALL_CANCELLED');
  if (typeof call?.callId !== 'string' || !call.callId) throw new MobileError('STABLE_CALL_ID_REQUIRED');
  const device = input?.device_id;
  if (typeof device !== 'string' || !device.trim() || device.length > 128) throw new MobileError('INVALID_DEVICE_ID');
  const key = 'pet-interrupt-' + createHash('sha256').update(JSON.stringify([botDir, call.role, call.callId])).digest('hex');
  const existing = pending.get(key);
  if (existing) {
    if (existing.device !== device) throw new MobileError('CALL_ARGUMENT_CONFLICT');
    return existing.result;
  }
  const result = (async () => {
    let event = host.store.range({ source, senderKey: key, limit: 4 }).find(e => e.type === 'coo_mobile.pet_control');
    if (event && event.meta?.device_id !== device) throw new MobileError('CALL_ARGUMENT_CONFLICT');
    if (!event) event = await host.pushEvent({ source, type: 'coo_mobile.pet_control', origin: 'internal',
      ts: new Date().toISOString(), senderKey: key, text: '[手机小人动作中断请求]',
      meta: { device_id: device, action: 'interrupt' } }, { deliver: false });
    return JSON.stringify({ state: 'queued_for_phone', event_cursor: event.cursor, phone_received: 'unknown' });
  })();
  pending.set(key, { device, result });
  try { return await result; } finally { pending.delete(key); }
}
