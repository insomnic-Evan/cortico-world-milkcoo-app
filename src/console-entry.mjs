/** Explicit public UI address; never derived from the channel host, port or token. */
export function consoleEntry(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return { configured: false, url: '' };
  const url = new URL(text);
  if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password)
    throw new Error('CONSOLE_UI_URL_INVALID');
  return { configured: true, url: url.href };
}
