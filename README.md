# Cloudflare Tunnel for COGNIX[WS]

Reach COGNIX[WS] from any network at your own address, through a
[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/).
Nothing is installed on the phone, and every device still pairs with a code.

An official tunnel extension (ADR-0349 in the COGNIX[WS] repository). It needs
COGNIX[WS] with extension manifest apiVersion 7 and Node.js 22 or newer.

## Set it up

1. In Cloudflare, open **Zero Trust → Networks → Tunnels** and create a tunnel
   of type **Cloudflared**.
2. Add a **public hostname** to it, for example `pc.example.com` on a domain
   you have on Cloudflare. Set its service to **HTTP** and `localhost:18445`
   (or the local port you choose below).
3. Copy the tunnel token from **Install connector**: it is the long value after
   `--token`. You do not run the command; this extension runs cloudflared.
4. In COGNIX[WS], open **Settings ▸ Tunnels → Add a tunnel → Cloudflare Tunnel**,
   review and install it, then open its settings and enter the token, the
   public address and the local port.

The tunnel shows **Connected** in Settings ▸ Tunnels once Cloudflare accepts
it. Pair a device then offers the public address; the phone opens it on any
network.

## What it does

- Downloads cloudflared 2026.10.1 from its GitHub release once, into its own
  data folder, and refuses it unless its SHA-256 matches the one pinned in
  `server/cloudflared.mjs`. Linux (amd64, arm64, WSL included) only for now.
- Asks COGNIX[WS] for a route on `127.0.0.1:<local port>` for the public
  address. Every request through it is a visitor that must pair; it is never
  treated as this computer.
- Runs `cloudflared tunnel run` with the token in its environment (never on
  the command line), and reports a closed status: connected, connecting,
  needs setup or needs attention, with the next action.
- Restarts cloudflared when it exits; stops trying when Cloudflare refuses the
  token, until you save new settings.

The token is stored protected by COGNIX[WS] and is not part of backups: a
restored computer asks for it again.

## Develop

```sh
node --test test/*.test.mjs
```

No dependencies. License: Apache-2.0.
