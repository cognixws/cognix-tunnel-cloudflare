import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkSettings, parseToken, validHostname, validPort } from '../server/settings.mjs';
import { classify, ensureBinary, binaryPath } from '../server/cloudflared.mjs';
import { Tunnel } from '../server/tunnel.mjs';
import { createServer } from '../server/server.mjs';

const token = Buffer.from(JSON.stringify({ a: 'acc0123456789abcdef', t: '2b3c4d5e-6f70-4182-93a4-b5c6d7e8f901', s: 'c2VjcmV0LXNlY3JldC1zZWNyZXQ=' })).toString('base64');

test('settings: token, address and port', () => {
  assert.ok(parseToken(token));
  for (const bad of ['', 'not-a-token', Buffer.from('{"a":"x"}').toString('base64'), 'a'.repeat(5000)]) assert.equal(parseToken(bad), null);
  for (const ok of ['pc.example.com', 'PC.Example.com.', 'a-b.c.example.org']) assert.ok(validHostname(ok), ok);
  for (const bad of ['', 'localhost', 'x.localhost', 'intranet', '1.2.3.4', 'https://pc.example.com', 'pc example.com']) assert.ok(!validHostname(bad), bad);
  assert.ok(validPort(18445)); assert.ok(!validPort(80)); assert.ok(!validPort('x'));
  assert.doesNotThrow(() => checkSettings({ values: { hostname: 'pc.example.com', local_port: 18445 }, secrets: { token } }));
  assert.doesNotThrow(() => checkSettings({ values: { hostname: 'pc.example.com' } }), 'an unchanged token is absent');
  assert.throws(() => checkSettings({ secrets: { token: 'garbage-token-garbage-token-garbage-token' } }), /not a Cloudflare tunnel token/);
  assert.throws(() => checkSettings({ values: { hostname: 'localhost' } }), /host name/);
  assert.throws(() => checkSettings({ values: { local_port: 22 } }), /1024 and 65535/);
});

test('the log says when the tunnel is up or the token is refused', () => {
  assert.equal(classify('2026-10-17T12:00:00Z INF Registered tunnel connection connIndex=0 location=gru01'), 'connected');
  assert.equal(classify('ERR Provided Tunnel token is not valid.'), 'bad-token');
  assert.equal(classify('2026-10-17T21:35:17Z ERR Register tunnel error from server side error="Failed to get tunnel" connIndex=0 event=0 ip=2606:4700:a8::9'), 'bad-token');
  assert.equal(classify('WRN Retrying connection in up to 2s'), 'reconnecting');
  assert.equal(classify('INF Starting tunnel'), '');
});

// fakeGet serves a redirect, then the bytes, as GitHub release downloads do.
function fakeGet(bytes) {
  return (url, cb) => {
    const req = new EventEmitter();
    req.setTimeout = () => req; req.destroy = err => req.emit('error', err);
    queueMicrotask(() => {
      const res = new PassThrough();
      if (url.hostname === 'github.com') { res.statusCode = 302; res.headers = { location: 'https://objects.githubusercontent.com/x' }; cb(res); res.end(); return; }
      res.statusCode = 200; res.headers = {}; cb(res); res.end(bytes);
    });
    return req;
  };
}

test('cloudflared is downloaded once and only with the pinned hash', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cft-'));
  const bytes = Buffer.from('#!/bin/sh\necho fake\n');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const path = await ensureBinary(dir, { asset: { name: 'cloudflared-linux-amd64', sha256 }, get: fakeGet(bytes) });
  assert.equal(path, binaryPath(dir));
  assert.deepEqual(readFileSync(path), bytes);
  const other = mkdtempSync(join(tmpdir(), 'cft-'));
  await assert.rejects(ensureBinary(other, { asset: { name: 'cloudflared-linux-amd64', sha256: '0'.repeat(64) }, get: fakeGet(bytes) }), /checksum mismatch/);
  assert.ok(!existsSync(binaryPath(other)), 'a wrong hash leaves nothing behind');
  await assert.rejects(ensureBinary(other, { asset: null }), /unsupported platform/);
});

function fakeHost(settings, { routeError } = {}) {
  const calls = [];
  return { calls, request: async (path, opts = {}) => {
    calls.push([opts.method || 'GET', path, opts.body]);
    if (path === '/api/ext/v1/settings') return settings;
    if (path === '/api/ext/v1/tunnel/routes' && opts.method === 'POST') { if (routeError) throw routeError; return { id: 'rt-1', port: opts.body.port }; }
    return null;
  } };
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => { child.killed = true; child.emit('exit', 0); };
  return child;
}

const settings = { values: { hostname: 'PC.example.com', local_port: 18445 }, secrets: { token } };
const tick = () => new Promise(r => setTimeout(r, 10));

test('without settings the tunnel asks for them', async () => {
  const t = new Tunnel({ host: fakeHost({ values: {}, secrets: {} }), dataDir: '/x', ensure: async () => '/bin/cf' });
  await t.start();
  assert.deepEqual(t.status(), { state: 'needs-setup', addresses: [], phoneNeeds: 'nothing', reach: 'internet', next: 'settings' });
});

test('a full start: route on the fixed port, token by environment, connected', async () => {
  const host = fakeHost(settings);
  let spawned;
  const t = new Tunnel({ host, dataDir: '/x', ensure: async () => '/bin/cf', spawn: (bin, args, opts) => { spawned = { bin, args, opts, child: fakeChild() }; return spawned.child; } });
  await t.start();
  assert.deepEqual(host.calls.find(c => c[1] === '/api/ext/v1/tunnel/routes')[2], { address: 'pc.example.com', clientHeader: 'CF-Connecting-IP', port: 18445 });
  assert.equal(spawned.bin, '/bin/cf');
  assert.ok(!spawned.args.join(' ').includes(token), 'the token never reaches argv');
  assert.equal(spawned.opts.env.TUNNEL_TOKEN, token);
  assert.equal(t.status().state, 'connecting');
  spawned.child.stderr.write('INF Registered tunnel connection connIndex=0\n');
  await tick();
  assert.deepEqual(t.status(), { state: 'connected', addresses: ['pc.example.com'], phoneNeeds: 'nothing', reach: 'internet', next: '' });
  await t.stop();
  assert.ok(spawned.child.killed);
  assert.ok(host.calls.some(c => c[0] === 'DELETE' && c[1] === '/api/ext/v1/tunnel/routes/rt-1'));
});

test('a busy port or a refused token is a next action, not a crash', async () => {
  const busy = new Tunnel({ host: fakeHost(settings, { routeError: Object.assign(new Error('busy'), { status: 409 }) }), dataDir: '/x', ensure: async () => '/bin/cf' });
  await busy.start();
  assert.deepEqual([busy.status().state, busy.status().next], ['needs-attention', 'settings']);
  let child;
  const refused = new Tunnel({ host: fakeHost(settings), dataDir: '/x', ensure: async () => '/bin/cf', spawn: () => (child = fakeChild()) });
  await refused.start();
  child.stderr.write('ERR Provided Tunnel token is not valid.\n');
  await tick();
  child.emit('exit', 1);
  await tick();
  assert.deepEqual([refused.status().state, refused.status().next], ['needs-attention', 'settings']);
});

test('cloudflared exiting is retried', async () => {
  let spawns = 0; const children = [];
  const t = new Tunnel({ host: fakeHost(settings), dataDir: '/x', ensure: async () => '/bin/cf', delay: async () => {}, spawn: () => { spawns++; const c = fakeChild(); children.push(c); return c; } });
  await t.start();
  children[0].emit('exit', 1);
  await tick();
  assert.equal(spawns, 2);
  await t.stop();
});

test('only COGNIX, with the proxy secret, may ask the process', async () => {
  const t = { status: () => ({ state: 'connected' }) };
  const server = createServer(t, { secret: 'shh' });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  assert.equal((await fetch(base + '/status')).status, 401);
  const ok = await fetch(base + '/status', { headers: { 'X-PiCode-Proxy-Secret': 'shh' } });
  assert.deepEqual(await ok.json(), { state: 'connected' });
  const bad = await fetch(base + '/settings/check', { method: 'POST', headers: { 'X-PiCode-Proxy-Secret': 'shh' }, body: JSON.stringify({ secrets: { token: 'nope-nope-nope-nope-nope-nope-nope-nope-nope' } }) });
  assert.equal(bad.status, 400);
  assert.doesNotMatch(await bad.text(), /nope/, 'a candidate token is never echoed');
  server.close();
});
