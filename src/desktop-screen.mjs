// Desktop capture requires a documented provider. This release does not import host internals.
const unavailableMessage = '当前版本未提供电脑读屏；手机屏幕共享不受影响。';
async function unavailableCapture() { throw new Error(unavailableMessage); }

export class DesktopScreenSampler {
  constructor(host, context, captureFactory = unavailableCapture, canAcceptImage = async () => host.modelFacts?.accepts?.('image/jpeg') === true) {
    this.host = host; this.context = context; this.captureFactory = captureFactory;
    this.canAcceptImage = canAcceptImage;
    this.running = false; this.error = null; this.latest = null; this.capture = null;
    this.seconds = 10; this.adaptive = true; this.proactive = false; this.generation = 0;
  }
  state() { const available = this.captureFactory !== unavailableCapture; return { available, running: this.running, seconds: this.seconds, adaptive: this.adaptive, proactive: this.proactive,
    captured_at: this.latest?.captured_at ?? null, model_accepts_image: this.host?.modelFacts?.accepts?.('image/jpeg') === true, error: this.error ?? (available ? null : unavailableMessage) }; }
  async configure(options) {
    if (!options || typeof options !== 'object' || typeof options.enabled !== 'boolean') throw new Error('INVALID_DESKTOP_SCREEN_CONFIG');
    if (!options.enabled) { await this.stop(); return this.state(); }
    if (!Number.isInteger(options.seconds) || options.seconds < 1 || options.seconds > 86399 || typeof options.adaptive !== 'boolean' || typeof options.proactive !== 'boolean') throw new Error('INVALID_DESKTOP_SCREEN_CONFIG');
    this.seconds = options.seconds; this.adaptive = options.adaptive; this.proactive = options.proactive;
    if (!this.running) {
      const generation = ++this.generation;
      const capture = await this.captureFactory(this.host, this.context);
      if (generation !== this.generation) { await capture.stop(); return this.state(); }
      this.capture = capture; this.running = true; this.error = null; this.previous = null; this.lastCursor = null; this.lastPublished = 0;
      void this.tick(generation);
    }
    return this.state();
  }
  async tick(generation) {
    if (!this.running || generation !== this.generation) return;
    try {
      const frame = await this.capture.take();
      if (!this.running || generation !== this.generation) return;
      let change = 1;
      if (this.previous && this.previous.length === frame.pixels.length) {
        let sum = 0; for (let i = 0; i < frame.pixels.length; i++) sum += Math.abs(frame.pixels[i] - this.previous[i]);
        change = sum / (frame.pixels.length * 255);
      }
      this.previous = frame.pixels;
      const cursor = JSON.stringify(frame.cursor), moved = this.lastCursor !== null && cursor !== this.lastCursor;
      this.lastCursor = cursor;
      let interval = this.seconds * 1000;
      if (this.adaptive) interval = moved || change >= .045 ? Math.max(1000, interval / 2) : change < .008 ? Math.min(86399000, interval * 3) : interval;
      const now = Date.now();
      if (!this.lastPublished || now - this.lastPublished >= interval) {
        this.latest = { bytes: frame.bytes, captured_at: frame.captured_at }; this.lastPublished = now;
        if (this.proactive && await this.canAcceptImage()) {
          await this.host.pushEvent({ source: this.context.id ?? 'milkcoo_app', type: 'coo_mobile.desktop_screen', origin: 'external', ts: frame.captured_at,
            text: `[电脑屏幕更新，采集于 ${frame.captured_at}]`, meta: { captured_at: frame.captured_at },
            blobs: [{ bytes: frame.bytes, mime: 'image/jpeg', name: 'desktop-screen.jpg', fallbackText: '电脑屏幕图片，无法识别时不要猜测。' }] }, { trigger: 'flush' });
        }
      }
      this.error = null;
    } catch (error) { this.error = String(error?.message ?? error); }
    if (this.running && generation === this.generation) {
      const delay = this.adaptive ? Math.min(2000, this.seconds * 1000) : Math.min(5000, this.seconds * 1000);
      this.timer = setTimeout(() => void this.tick(generation), delay); this.timer.unref?.();
    }
  }
  async stop() {
    this.running = false; ++this.generation; clearTimeout(this.timer); this.latest = null; this.previous = null;
    const capture = this.capture; this.capture = null;
    if (capture) await capture.stop();
  }
}
