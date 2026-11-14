/** Forward the official loopback mailbox through the already authenticated mobile channel. */
export class BottleBridge {
  constructor(modelControl, fetchImpl = globalThis.fetch) {
    this.modelControl = modelControl;
    this.fetch = fetchImpl;
    this.cached = null;
    this.discovering = null;
  }

  async mailbox(force = false) {
    if (!force && this.cached && this.cached.until > Date.now()) return this.cached.url;
    if (this.discovering) return this.discovering;
    this.discovering = (async () => {
      const value = await this.modelControl.request('/api/webui/providers/world%3Abottle/panels/mailbox/status', { args: [] }, 12000);
      const url = new URL(value?.url);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password ||
          url.pathname !== '/' || url.search || url.hash) throw new Error('BOTTLE_MAILBOX_UNAVAILABLE');
      this.cached = { url, until: Date.now() + 30000 };
      return url;
    })();
    try { return await this.discovering; } finally { this.discovering = null; }
  }

  async handle(req, res, url) {
    const relative = url.pathname.slice('/v1/bottle'.length) || '/';
    if (!['GET', 'POST'].includes(req.method) || !relative.startsWith('/') || relative.startsWith('//') ||
        relative.includes('\\') || relative.includes('\0')) return reply(res, 404, '信箱里没有这个页面。');
    if (req.method === 'POST' && req.headers['x-bottle'] !== '1') return reply(res, 403, '请从信箱页面操作。');
    let body;
    try { body = req.method === 'POST' ? await readBody(req) : undefined; }
    catch { return reply(res, 400, '信箱请求过大或未能读取。'); }

    const forward = async force => {
      const base = await this.mailbox(force);
      const target = new URL(relative + url.search, base);
      if (target.origin !== base.origin) throw new Error('BOTTLE_DESTINATION_CHANGED');
      const headers = {};
      if (req.method === 'POST') {
        headers['x-bottle'] = '1';
        headers['content-type'] = String(req.headers['content-type'] || 'application/json');
      }
      return this.fetch(target, { method: req.method, headers, ...(body === undefined ? {} : { body }),
        redirect: 'manual', signal: AbortSignal.timeout(30000) });
    };

    try {
      let response;
      try { response = await forward(false); }
      catch (error) {
        this.cached = null;
        // A POST might have reached the mailbox; retrying could send a letter twice.
        if (req.method !== 'GET') throw error;
        response = await forward(true);
      }
      const bytes = await readResponse(response, 4 * 1024 * 1024);
      res.writeHead(response.status, { 'content-type': response.headers.get('content-type') || 'application/octet-stream',
        'content-length': bytes.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(bytes);
    } catch {
      reply(res, 503, req.method === 'POST' ? '未能确认操作结果，请刷新信箱查看后再操作。' : '信箱暂时无法连接，请检查漂流瓶 World。');
    }
  }
}

async function readBody(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) throw new Error('BOTTLE_BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readResponse(response, limit) {
  if (!response.body) return Buffer.alloc(0);
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error('BOTTLE_RESPONSE_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function reply(res, status, message) {
  const bytes = Buffer.from(JSON.stringify({ ok: false, message }));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': bytes.length, 'cache-control': 'no-store' });
  res.end(bytes);
}
