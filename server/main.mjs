import { HostAPI } from './host.mjs';
import { Tunnel } from './tunnel.mjs';
import { createServer } from './server.mjs';

const required = ['PICODE_URL', 'PICODE_EXT_TOKEN', 'PICODE_EXT_DATA', 'PICODE_EXT_PORT', 'PICODE_EXT_PROXY_SECRET'];
if (Number(process.versions.node.split('.')[0]) < 22 || required.some(key => !process.env[key])) {
  process.stderr.write('Cloudflare Tunnel needs Node.js 22 or newer and must be started by COGNIX[WS].\n');
  process.exit(1);
}
const host = new HostAPI({ url: process.env.PICODE_URL, token: process.env.PICODE_EXT_TOKEN, dataDir: process.env.PICODE_EXT_DATA });
const tunnel = new Tunnel({ host, dataDir: process.env.PICODE_EXT_DATA });
const server = createServer(tunnel, { secret: process.env.PICODE_EXT_PROXY_SECRET });
server.listen(Number(process.env.PICODE_EXT_PORT), '127.0.0.1', () => { tunnel.start(); });
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => {
  setTimeout(() => process.exit(0), 3000).unref();
  await tunnel.stop();
  server.close(() => process.exit(0));
});
