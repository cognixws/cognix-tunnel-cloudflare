// Settings checks run before COGNIX saves anything (ADR-0327). Messages are
// fixed strings: a candidate token is never echoed, logged or kept.

export class SettingsError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A Cloudflare tunnel token is base64 of {"a": account, "t": tunnel id, "s": secret}.
export function parseToken(token) {
  if (typeof token !== 'string' || token.length < 40 || token.length > 4096 || !/^[A-Za-z0-9+/=_-]+$/.test(token)) return null;
  let data;
  try { data = JSON.parse(Buffer.from(token, 'base64').toString('utf8')); } catch { return null; }
  if (!data || typeof data.a !== 'string' || typeof data.s !== 'string' || typeof data.t !== 'string' || !UUID.test(data.t) || !data.a || !data.s) return null;
  return { account: data.a, tunnel: data.t };
}

export function validHostname(value) {
  if (typeof value !== 'string') return false;
  const host = value.trim().toLowerCase().replace(/\.$/, '');
  if (!host || host.length > 253 || host === 'localhost' || host.endsWith('.localhost')) return false;
  const labels = host.split('.');
  return labels.length >= 2 && labels.every(l => LABEL.test(l)) && !/^\d+$/.test(labels[labels.length - 1]);
}

export function validPort(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1024 && n <= 65535;
}

// body is {values, secrets}: a secret that did not change is absent.
export function checkSettings(body) {
  const values = body?.values || {};
  const token = body?.secrets?.token;
  if (token !== undefined && token !== '' && !parseToken(token)) throw new SettingsError('This is not a Cloudflare tunnel token. Copy it again from Install connector.');
  if (values.hostname !== undefined && values.hostname !== '' && !validHostname(values.hostname)) throw new SettingsError('Write the public address as a host name, like pc.example.com.');
  if (values.local_port !== undefined && values.local_port !== '' && !validPort(values.local_port)) throw new SettingsError('Choose a local port between 1024 and 65535.');
}
