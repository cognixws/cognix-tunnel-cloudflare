import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { checkSettings } from './settings.mjs';

// The process's own endpoint: only COGNIX[WS], holding the proxy secret,
// may ask it anything.
export function createServer(tunnel, { secret }) {
  return http.createServer(async (request, response) => {
    const reply = (status, data) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(data)); };
    const supplied = Buffer.from(request.headers['x-picode-proxy-secret'] || '');
    const expected = Buffer.from(secret || '');
    if (!expected.length || expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) { reply(401, { message: 'Open this through COGNIX[WS].' }); return; }
    const path = new URL(request.url, 'http://127.0.0.1').pathname;
    if (request.method === 'GET' && path === '/status') { reply(200, tunnel.status()); return; }
    if (request.method === 'POST' && path === '/settings/check') {
      const chunks = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; if (size > 16 << 10) { reply(413, { message: 'This request is too large.' }); return; } chunks.push(chunk); }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { reply(400, { message: 'This request could not be read.' }); return; }
      try { checkSettings(body); reply(200, { valid: true }); }
      catch (error) { reply(error.status || 400, { message: error.message }); }
      return;
    }
    reply(404, { message: 'This action is unavailable.' });
  });
}
