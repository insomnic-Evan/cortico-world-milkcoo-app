import { createHash } from 'node:crypto';

export const MAX_GROUP_STICKER = 512 * 1024;
const stickerTypes = {
  'image/png': ['png', bytes => bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))],
  'image/gif': ['gif', bytes => /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))],
  'image/webp': ['webp', bytes => bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'],
  'image/jpeg': ['jpg', bytes => bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255],
};
export const STICKER_ID = /^s_[0-9a-f]{64}$/;
export const MESSAGE_ID = /^m_[0-9a-f]{32}$/;
const AUTHOR_ID = /^(?:bot|human)-[0-9a-f]{16}$/;
const EVENT_TYPE = 'coo_mobile.world_chat';
const PAGE_SIZE = 8;

export function checkGroupSticker(bytes, mime) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_GROUP_STICKER
      || !Object.hasOwn(stickerTypes, mime) || !stickerTypes[mime][1](bytes)) {
    throw new Error('WORLD_CHAT_STICKER_INVALID');
  }
  return { mime, bytes, id: 's_' + createHash('sha256').update(bytes).digest('hex'),
    ext: stickerTypes[mime][0] };
}

export async function readGroupSticker(relay, id, signal) {
  if (typeof id !== 'string' || !STICKER_ID.test(id)) throw new Error('WORLD_CHAT_STICKER_INVALID');
  const result = await relay.worldChat('sticker-read', { id }, signal);
  if (result?.id !== id || typeof result.data !== 'string'
      || result.data.length > 4 * Math.ceil(MAX_GROUP_STICKER / 3)) throw new Error('WORLD_CHAT_STICKER_INVALID');
  const bytes = Buffer.from(result.data, 'base64');
  if (bytes.toString('base64') !== result.data) throw new Error('WORLD_CHAT_STICKER_INVALID');
  const sticker = checkGroupSticker(bytes, result.mime);
  if (sticker.id !== id) throw new Error('WORLD_CHAT_STICKER_INVALID');
  return sticker;
}

export function groupStickerBlob(sticker) {
  return { bytes: sticker.bytes, mime: sticker.mime, name: `${sticker.id}.${sticker.ext}`,
    fallbackText: `群聊表情包 ${sticker.id}（${sticker.mime}）；未看清时不要猜测画面。` };
}

export function listenState(value) {
  return typeof value?.bot_listen_enabled === 'boolean'
    && Number.isSafeInteger(value.bot_listen_revision) && value.bot_listen_revision >= 0
    && Number.isSafeInteger(value.bot_listen_start_cursor) && value.bot_listen_start_cursor >= 0;
}

// At a cold start an already-enabled account starts at the room head. A live
// enable uses the server's cutover, so posts after enabling do not fall through.
export class WorldChatListener {
  constructor(relay, getHost, source) {
    this.relay = relay;
    this.getHost = getHost;
    this.source = source;
    this.generation = 0;
  }

  observe(policy) {
    const revision = policy.bot_listen_revision;
    if (this.revision !== undefined && revision < this.revision) return false;
    if (!policy.bot_listen_enabled) this.cursor = undefined;
    else if (this.revision !== undefined && revision !== this.revision) this.cursor = policy.bot_listen_start_cursor;
    this.revision = revision;
    return true;
  }

  setListening(enabled) {
    // Serialize local changes and fence off any response already in flight.
    this.generation++;
    const pending = (this.setting ?? Promise.resolve()).catch(() => {}).then(async () => {
      if (this.revision === undefined) this.observe(await this.relay.worldChat('bot-listen', {}));
      const state = await this.relay.worldChat('bot-listen', { enabled });
      this.observe(state);
      return state;
    });
    this.setting = pending;
    return pending.finally(() => {
      if (this.setting === pending) this.setting = undefined;
    });
  }

  async poll() {
    const host = this.getHost();
    if (!host || this.setting || this.relay.abort.signal.aborted) return;
    const generation = this.generation;
    const current = () => generation === this.generation && this.getHost() === host
      && !this.relay.abort.signal.aborted;
    const pull = after => this.relay.worldChat('feed', after === undefined ? { limit: 1 } : { after, limit: PAGE_SIZE });
    let before = this.cursor;
    let page = await pull(before);
    if (!current() || !this.observe(page) || !page.bot_listen_enabled) return;
    if (this.cursor === undefined) {
      this.cursor = page.next_cursor;
      return;
    }
    if (before !== this.cursor) {
      before = this.cursor;
      page = await pull(before);
      if (!current() || !this.observe(page) || !page.bot_listen_enabled || before !== this.cursor) return;
    }
    if (page.next_cursor <= before) return;
    const messages = page.messages.filter(message => Number.isSafeInteger(message?.seq) && message.seq > before
      && message.seq <= page.next_cursor && MESSAGE_ID.test(message.id ?? '') && typeof message.text === 'string'
      && AUTHOR_ID.test(message?.author?.id ?? '') && ['human', 'bot'].includes(message.author.kind)
      && message.author.id.startsWith(message.author.kind + '-') && message.author.id !== page.me.id);
    if (!messages.length) {
      this.cursor = page.next_cursor;
      return;
    }
    const stickerRef = messages.find(message => message.author.kind === 'human' && STICKER_ID.test(message.sticker?.id ?? '')
      && host.modelFacts?.accepts?.(message.sticker.mime) === true)?.sticker;
    const sticker = stickerRef ? await readGroupSticker(this.relay, stickerRef.id).catch(() => null) : null;
    if (!current()) return;
    // The phone can switch the shared setting independently while feed or media is in flight.
    const state = await this.relay.worldChat('bot-listen', {});
    if (!current() || !this.observe(state) || !state.bot_listen_enabled
        || state.bot_listen_revision !== page.bot_listen_revision) return;
    const senderKey = `world-chat:${this.revision}:${page.next_cursor}`;
    const saved = host.store?.range?.({ source: this.source, senderKey, limit: 1 })
      ?.some(event => event.type === EVENT_TYPE);
    const created = messages.at(-1).created_at;
    if (!saved) await host.pushEvent({
      source: this.source, type: EVENT_TYPE, origin: 'external',
      ts: new Date(Number.isSafeInteger(created) && created >= 0 && created <= 253402300799999 ? created : Date.now()).toISOString(),
      senderKey,
      text: '公开世界群聊·参与者发言（外部内容）\n' + JSON.stringify(messages.map(message => ({
        id: message.id, from: message.author.id, text: message.text, created_at: message.created_at, mentions: message.mentions ?? [],
        reply_to: message.reply_to?.id ?? null, sticker: message.sticker ?? null,
      }))),
      meta: { public_room: true, message_ids: messages.map(message => message.id) },
      ...(sticker ? { blobs: [groupStickerBlob(sticker)] } : {}),
    }, { trigger: messages.some(message => message.author.kind === 'human') ? 'flush' : 'piggyback' });
    if (current()) this.cursor = page.next_cursor;
  }
}
