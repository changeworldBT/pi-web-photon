# Photon iMessage sidecar

Small Node helper that bridges the pi-web-ui Photon plugin to Photon's
Spectrum SDK (`spectrum-ts`). Photon has no public HTTP send endpoint
today, so send/typing/reaction requests and the inbound message stream
are proxied through this sidecar over a loopback HTTP control channel.

## What it does

- runs `Spectrum({ projectId, projectSecret, providers: [imessage.config()] })`
- exposes a loopback-only HTTP control channel for the host
  (auth via the `X-Photon-Bridge-Token` header)
- drains the inbound message stream so `spectrum-ts` keeps its
  reconnect/heartbeat machinery alive and the host can receive inbound
  messages over `GET /inbound` (NDJSON)

## Control channel

| Route | Purpose |
|---|---|
| `GET /inbound` | NDJSON stream of normalized inbound message events |
| `POST /send` | `{ spaceId, text, format }` — send text |
| `POST /send-attachment` | `{ spaceId, path, name?, mimeType?, caption?, kind? }` |
| `POST /send-richlink`, `/typing`, `/react`, `/unreact` | auxiliaries |
| `POST /healthz` | liveness + stream health snapshot |

All routes except `/healthz` require the shared token header.

## Run

```bash
PHOTON_PROJECT_ID=... PHOTON_PROJECT_SECRET=... \
PHOTON_SIDECAR_PORT=8791 PHOTON_SIDECAR_TOKEN=$(openssl rand -hex 16) \
node index.mjs
```

In normal use the pi-web-ui photon plugin does not manage this process:
run it under systemd (user units work well) with the four environment
variables above. `PHOTON_SIDECAR_BIND` defaults to `127.0.0.1` — keep it
loopback-only; the token is the only other gate.
