import { spawn as spawnProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { classify, ensureBinary } from './cloudflared.mjs';
import { parseToken, validHostname, validPort } from './settings.mjs';

// The tunnel's life inside the supervised process: read the settings, get
// cloudflared, open the route on the fixed port, run cloudflared and report a
// closed status. A failure is a state with one next action, never a crash.
export class Tunnel {
  constructor({ host, dataDir, spawn = spawnProcess, ensure = ensureBinary, delay = ms => new Promise(r => setTimeout(r, ms)) }) {
    this.host = host; this.dataDir = dataDir; this.spawn = spawn; this.ensure = ensure; this.delay = delay;
    this.state = 'connecting'; this.next = ''; this.hostname = ''; this.route = null; this.child = null;
    this.stopped = false; this.failures = 0;
  }

  status() {
    return {
      state: this.state,
      addresses: this.state === 'connected' && this.hostname ? [this.hostname] : [],
      phoneNeeds: 'nothing', reach: 'internet', next: this.next,
    };
  }

  set(state, next = '') { this.state = state; this.next = next; }

  async start() {
    let settings;
    try { settings = await this.host.request('/api/ext/v1/settings'); }
    catch { this.set('needs-attention', 'retry'); return; }
    const token = settings?.secrets?.token || '';
    const hostname = String(settings?.values?.hostname || '').trim().toLowerCase();
    const port = Number(settings?.values?.local_port || 18445);
    if (!parseToken(token) || !validHostname(hostname) || !validPort(port)) { this.set('needs-setup', 'settings'); return; }
    this.hostname = hostname;
    let binary;
    while (!this.stopped) {
      try { binary = await this.ensure(this.dataDir); break; }
      catch (error) {
        if (error.code === 'unsupported-platform') { this.set('needs-attention', 'open'); return; }
        this.set('needs-attention', 'retry');
        await this.delay(60_000);
      }
    }
    if (this.stopped) return;
    try {
      this.route = await this.host.request('/api/ext/v1/tunnel/routes', { method: 'POST', body: { address: hostname, clientHeader: 'CF-Connecting-IP', port } });
    } catch (error) {
      this.set('needs-attention', error.status === 409 || error.status === 400 ? 'settings' : 'retry');
      return;
    }
    this.run(binary, token);
  }

  run(binary, token) {
    if (this.stopped) return;
    this.set('connecting');
    // The token reaches cloudflared through its environment, never argv, so
    // it does not show in a process list.
    const child = this.spawn(binary, ['tunnel', '--no-autoupdate', 'run'], { env: { ...process.env, TUNNEL_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    let badToken = false;
    const read = stream => stream && createInterface({ input: stream }).on('line', line => {
      const c = classify(line);
      if (c === 'connected') { this.failures = 0; this.set('connected'); }
      else if (c === 'bad-token') { badToken = true; this.set('needs-attention', 'settings'); child.kill('SIGTERM'); }
      else if (c === 'reconnecting' && this.state === 'connected') this.set('connecting');
    });
    read(child.stdout); read(child.stderr);
    child.on('exit', async () => {
      if (this.child === child) this.child = null;
      if (this.stopped) return;
      if (badToken) return; // wait for new settings: saving them restarts this process
      this.failures++;
      this.set('needs-attention', 'retry');
      await this.delay(Math.min(60_000, 2_000 * 2 ** Math.min(this.failures, 5)));
      this.run(binary, token);
    });
  }

  async stop() {
    this.stopped = true;
    if (this.child) this.child.kill('SIGTERM');
    if (this.route?.id) {
      try { await this.host.request('/api/ext/v1/tunnel/routes/' + encodeURIComponent(this.route.id), { method: 'DELETE' }); } catch { /* the host closes it when this process ends */ }
    }
  }
}
