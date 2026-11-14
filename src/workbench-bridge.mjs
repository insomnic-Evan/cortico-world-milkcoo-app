import { buildCheckpoint } from './workbench/checkpoint.mjs';
import { DesktopBridge } from './workbench/desktop.mjs';
import { sealDeployment } from './workbench/deployment-backup.mjs';
import { captureBackup } from './workbench/capture-backup.mjs';
import { dirname } from 'node:path';

/** Exposes the existing Tina computer contracts on the already authenticated Coo channel. */
export class WorkbenchBridge {
  constructor(context, token) {
    this.context = context; this.token = token;
    this.desktop = new DesktopBridge({ deployment: context.botDir, url: `http://127.0.0.1:${context.cfg.consolePort ?? 17788}` });
    this.checkpoint = null; this.capture = null; this.backup = null;
  }
  async snapshot() {
    if (!this.checkpoint || Date.now() - this.checkpoint.readAt > 60000) {
      this.capture ??= Promise.resolve().then(() => buildCheckpoint(this.context.botDir))
        .then(value => this.checkpoint = { value, readAt: Date.now() }).finally(() => this.capture = null);
      await this.capture;
    }
    return this.checkpoint.value;
  }
  async handle(req, res, url, readJson, send) {
    if (url.pathname === '/v1/checkpoint' && req.method === 'GET') {
      const value = await this.snapshot();
      if (req.headers['if-none-match'] === `"${value.revision}"`) { res.writeHead(304); res.end(); return; }
      res.setHeader('etag', `"${value.revision}"`); send(res, 200, value); return;
    }
    const body = req.method === 'POST' ? await readJson(req) : undefined;
    let result;
    if (url.pathname === '/v1/desktop/public' && req.method === 'POST') {
      if (typeof body?.path !== 'string' || !body.path.startsWith('/api/') || !['GET', 'POST'].includes(body?.method))
        throw Object.assign(new Error('Unsupported public World route'), { status: 400 });
      result = await this.desktop.request(body.path, body.method, body.body ?? undefined);
      send(res, 200, result); return;
    }
    if (url.pathname === '/v1/desktop/activity' && req.method === 'GET') result = await this.desktop.activity(url.searchParams.get('after') ?? '');
    else if (url.pathname === '/v1/desktop/settings' && req.method === 'GET') result = await this.desktop.settings();
    else if (url.pathname === '/v1/desktop/settings' && req.method === 'POST') result = await this.desktop.save(body);
    else if (url.pathname === '/v1/desktop/options' && req.method === 'GET') result = await this.desktop.request('/api/config/options/' + encodeURIComponent(url.searchParams.get('kind') ?? ''));
    else if (url.pathname === '/v1/desktop/action' && req.method === 'POST') {
      result = { ok: true, result: await this.desktop.request(body.path, 'POST', body.body), readback: await this.desktop.settings() };
    } else if (url.pathname === '/v1/desktop/backup' && req.method === 'POST') {
      if (this.backup) throw Object.assign(new Error('部署备份正在进行'), { status: 409 });
      this.backup = this.createBackup();
      try { result = await this.backup; } finally { this.backup = null; }
    } else { send(res, 404, { error: 'WORKBENCH_ROUTE_NOT_FOUND' }); return; }
    send(res, 200, result);
  }
  async createBackup() {
    const { bytes, details } = await captureBackup(this.context.botDir, process.env.CORTICO_HOME || dirname(this.context.botDir));
    return sealDeployment(bytes, this.token, details);
  }
}
