import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, chmodSync } from 'node:fs';
import https from 'node:https';
import { join } from 'node:path';

// The cloudflared release this version runs, checked by the sha256 GitHub
// publishes for each asset. A new release is a new version of this extension,
// reviewed like any other update.
export const VERSION = '2026.10.1';
export const ASSETS = {
  'linux-x64': { name: 'cloudflared-linux-amd64', sha256: '3bfc539f45d2620c71debb7a86be0efa737ed5ccbad9eb85c787116900e5c586' },
  'linux-arm64': { name: 'cloudflared-linux-arm64', sha256: '2c65dfabf616c40efc7545d107d7a57ad5e21377e2964b7e88af19a238074a46' },
};
const ALLOWED_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);

export function assetFor(platform = process.platform, arch = process.arch) {
  return ASSETS[platform + '-' + arch] || null;
}

export function binaryPath(dataDir) {
  return join(dataDir, 'bin', 'cloudflared-' + VERSION);
}

function fetchVerified(url, dest, sha256, { get = https.get, redirects = 5, maxBytes = 120 << 20 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.hostname)) { reject(new Error('download refused: ' + u.hostname)); return; }
    const req = get(u, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects <= 0) { reject(new Error('too many redirects')); return; }
        fetchVerified(new URL(res.headers.location, u).toString(), dest, sha256, { get, redirects: redirects - 1, maxBytes }).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error('download failed: HTTP ' + res.statusCode)); return; }
      const hash = createHash('sha256');
      const out = createWriteStream(dest, { mode: 0o700 });
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) { req.destroy(new Error('download too large')); return; }
        hash.update(chunk);
      });
      res.pipe(out);
      out.on('finish', () => {
        const got = hash.digest('hex');
        if (got !== sha256) { rmSync(dest, { force: true }); reject(new Error('checksum mismatch')); return; }
        resolve();
      });
      res.on('error', reject); out.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(120_000, () => req.destroy(new Error('download timed out')));
  });
}

// ensureBinary downloads cloudflared once into the extension's data folder.
export async function ensureBinary(dataDir, { asset = assetFor(), get } = {}) {
  if (!asset) throw Object.assign(new Error('unsupported platform'), { code: 'unsupported-platform' });
  const path = binaryPath(dataDir);
  if (existsSync(path)) return path;
  mkdirSync(join(dataDir, 'bin'), { recursive: true });
  const tmp = path + '.part';
  rmSync(tmp, { force: true });
  await fetchVerified(`https://github.com/cloudflare/cloudflared/releases/download/${VERSION}/${asset.name}`, tmp, asset.sha256, { get });
  chmodSync(tmp, 0o755);
  renameSync(tmp, path);
  return path;
}

// classify reads one line of cloudflared's log into a state change.
export function classify(line) {
  if (/Registered tunnel connection/i.test(line)) return 'connected';
  // Observed with cloudflared 2026.10.1 for a token Cloudflare does not know:
  // ERR Register tunnel error from server side error="Failed to get tunnel".
  if (/Unauthorized|invalid (tunnel )?(token|secret)|token is invalid|Provided Tunnel token is not valid|error="Failed to get tunnel"/i.test(line)) return 'bad-token';
  if (/Unregistered tunnel connection|connection .*(lost|terminated)|Retrying connection/i.test(line)) return 'reconnecting';
  return '';
}
