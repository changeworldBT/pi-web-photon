# pi-web-photon

Photon iMessage channel for [pi-web-ui](https://github.com/xing-shuyin/pi-web-ui) — send and receive iMessages on Linux (or macOS) machines with zero public IP, via the [Photon](https://app.photon.codes/) managed Spectrum service.

## Layout

| Path | What |
|---|---|
| `plugin/` | pi-web-ui UI plugin: Photon iMessage bot & workbench (install via `pi-web-ui install changeworldBT/pi-web-photon/plugin`) |
| `sidecar/` | Loopback HTTP ⇄ `spectrum-ts` (gRPC) bridge process; run it under systemd next to pi-web-ui |

## How it works

```
iMessage ⇄ Photon Spectrum cloud ⇄ (gRPC) ⇄ sidecar ⇄ (loopback HTTP) ⇄ plugin ⇄ pi
```

- The sidecar holds the long-lived Spectrum gRPC stream (inbound NDJSON at `GET /inbound`) and exposes send/typing/react routes on loopback.
- The plugin consumes the inbound stream, dispatches messages to pi with per-sender session isolation, an allowlist, and slash commands, then replies in chunks.

## Quick start

1. **Sidecar**: create `~/.photon-sidecar/env` (chmod 600) with `PHOTON_PROJECT_ID`, `PHOTON_PROJECT_SECRET`, `PHOTON_SIDECAR_PORT=8791`, `PHOTON_SIDECAR_TOKEN=<openssl rand -hex 16>`, then run `node index.mjs` (see `sidecar/README.md`; a systemd user unit is the recommended way to keep it alive).
2. **Plugin**: `pi-web-ui install changeworldBT/pi-web-photon/plugin`, then in the 💬 Photon settings point it at the env file (default `~/.photon-sidecar/env`), configure the allowlist and home channel, and start the bot.

> Photon's free/shared line tier can only reply inside conversations that already exist — a target that has never messaged the line rejects outbound sends.

## License

MIT
