/**
 * plugins/photon/index.mjs
 * Photon iMessage (via Photon sidecar) integration for pi-web-ui.
 * Zero external dependencies (built-in fetch + node:crypto + node:fs).
 * Transport: a local Photon sidecar exposes loopback HTTP — POST /send,
 * /send-attachment for outbound, GET /inbound NDJSON long stream for inbound —
 * and bridges to the Photon cloud (spectrum-ts gRPC) which talks to iMessage.
 * Structure-aware Markdown chunks, isolated multi-turn sessions, access
 * control whitelist, and slash commands are carried over from the imessage plugin.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { chunkMarkdownText } from "./markdown-chunks.mjs";

export { chunkMarkdownText };

export const IMESSAGE_BOT_PREFIX = "🤖 PI\n";

/** Strips internal system markers from assistant response text before delivery. */
export function stripInternalMarkers(text) {
	return String(text ?? "")
		.replace(/\[\[[A-Za-z][A-Za-z0-9_-]*:[^\]]*\]\]/g, "")
		.replace(/\r\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** Generates a stable, privacy-preserving accountId from the space/sender key. */
export function peerAccountId(senderId, prefix = "ph") {
	const raw = String(senderId ?? "").trim();
	if (!raw) return `${prefix}_default`;
	const hash = createHash("sha256").update(raw).digest("hex").slice(0, 16);
	return `${prefix}_${hash}`;
}

/** Clean message text and strip bot reply markers. */
export function cleanIMessageText(textRaw = "") {
	let text = String(textRaw || "").trim();
	if (!text) return "";
	if (text.startsWith(IMESSAGE_BOT_PREFIX)) return "";
	return text.replace(/^@\S+\s+/g, "").trim();
}

const DEFAULT_SIDECAR_URL = "http://127.0.0.1:8791";
const DEFAULT_ENV_FILE = join(homedir(), ".photon-sidecar/env");

/** Home channel spaceId used when no recipient is configured. */
export const DEFAULT_RECIPIENT = "any;-;+8618657150392";
/** Sender whitelist applied when none is configured. */
export const DEFAULT_ALLOWED_USERS = ["+8618657150392"];

/** Reads the sidecar token from the KEY=VALUE env file. Never stored. */
export function readSidecarToken(envFile = DEFAULT_ENV_FILE) {
	let raw = "";
	try {
		raw = readFileSync(envFile, "utf8");
	} catch {
		return "";
	}
	for (const line of raw.split(/\r?\n/)) {
		const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
		if (m && m[1] === "PHOTON_SIDECAR_TOKEN") {
			return m[2].replace(/^["']|["']$/g, "");
		}
	}
	return "";
}

const HTTP_URL_RE = /https?:\/\/[^\s)'"<>]+/i;

/**
 * Send a text message through the Photon sidecar (POST /send).
 * format mirrors the sidecar's own send-format decision: text when the body
 * contains a raw URL (markdown data-detection can 500 there), else markdown.
 */
export async function photonSend(sidecar, spaceId, text, { format } = {}) {
	const url = String(sidecar?.sidecarUrl || DEFAULT_SIDECAR_URL).replace(/\/+$/, "");
	const safeSpace = String(spaceId || "").trim();
	const safeText = String(text ?? "");
	if (!safeSpace) throw new Error("Photon spaceId is required.");
	if (!safeText) throw new Error("Message text is required.");
	const token = sidecar.token ?? readSidecarToken(sidecar.envFile);
	const body = {
		spaceId: safeSpace,
		text: safeText,
		format: format === "text" || format === "markdown" ? format : HTTP_URL_RE.test(safeText) ? "text" : "markdown",
	};
	const res = await fetch(`${url}/send`, {
		method: "POST",
		headers: { "Content-Type": "application/json", "X-Photon-Bridge-Token": token },
		body: JSON.stringify(body),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok || data?.ok === false) {
		throw new Error(`Photon sidecar /send failed (${res.status}): ${data?.error || res.statusText || "unknown error"}`);
	}
	return { messageId: data.messageId ?? null, success: true };
}

const MIME_BY_EXT = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	m4a: "audio/mp4",
	mp3: "audio/mpeg",
	wav: "audio/wav",
	ogg: "audio/ogg",
	mp4: "video/mp4",
	mov: "video/quicktime",
	pdf: "application/pdf",
	txt: "text/plain",
	csv: "text/csv",
	json: "application/json",
	zip: "application/zip",
};

/** Guess a MIME type from a file extension (best effort, empty if unknown). */
export function guessMimeType(filePath) {
	const ext = String(filePath || "").split(".").pop().toLowerCase();
	return MIME_BY_EXT[ext] || "";
}

/**
 * Send a local file attachment through the Photon sidecar (POST /send-attachment).
 */
export async function photonSendAttachment(sidecar, spaceId, filePath, { caption, mimeType } = {}) {
	const url = String(sidecar?.sidecarUrl || DEFAULT_SIDECAR_URL).replace(/\/+$/, "");
	const safeSpace = String(spaceId || "").trim();
	const path = resolve(String(filePath || "").trim());
	if (!safeSpace) throw new Error("Photon spaceId is required.");
	if (!path) throw new Error("Attachment file path is required.");
	const info = await stat(path);
	if (!info.isFile()) throw new Error("Attachment must be a regular local file.");
	const token = sidecar.token ?? readSidecarToken(sidecar.envFile);
	const body = {
		spaceId: safeSpace,
		path,
		name: path.split(/[\\/]/).pop(),
		mimeType: mimeType || guessMimeType(path) || null,
		caption: caption || null,
	};
	const res = await fetch(`${url}/send-attachment`, {
		method: "POST",
		headers: { "Content-Type": "application/json", "X-Photon-Bridge-Token": token },
		body: JSON.stringify(body),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok || data?.ok === false) {
		throw new Error(`Photon sidecar /send-attachment failed (${res.status}): ${data?.error || res.statusText || "unknown error"}`);
	}
	return { messageId: data.messageId ?? null, success: true };
}

/**
 * Send a native iMessage poll (POST /send-poll). A tap on an option streams
 * back inbound as a poll_option event ({title, selected, pollTitle}).
 */
export async function photonSendPoll(sidecar, spaceId, title, options) {
	const url = String(sidecar?.sidecarUrl || DEFAULT_SIDECAR_URL).replace(/\/+$/, "");
	const safeSpace = String(spaceId || "").trim();
	const safeTitle = String(title || "").trim();
	const choices = (Array.isArray(options) ? options : []).map((o) => String(o || "").trim()).filter(Boolean);
	if (!safeSpace) throw new Error("Photon spaceId is required.");
	if (!safeTitle) throw new Error("Poll title is required.");
	if (choices.length < 2) throw new Error("Poll needs at least two options.");
	const token = sidecar.token ?? readSidecarToken(sidecar.envFile);
	const res = await fetch(`${url}/send-poll`, {
		method: "POST",
		headers: { "Content-Type": "application/json", "X-Photon-Bridge-Token": token },
		body: JSON.stringify({ spaceId: safeSpace, title: safeTitle, options: choices }),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok || data?.ok === false) {
		throw new Error(`Photon sidecar /send-poll failed (${res.status}): ${data?.error || res.statusText || "unknown error"}`);
	}
	return { messageId: data.messageId ?? null, success: true };
}

/**
 * Send an iMessage typing indicator through the sidecar (POST /typing).
 * iMessage expires the bubble after ~60s, so callers must refresh it.
 */
export async function photonTyping(sidecar, spaceId, state = "start") {
	const url = String(sidecar?.sidecarUrl || DEFAULT_SIDECAR_URL).replace(/\/+$/, "");
	const safeSpace = String(spaceId || "").trim();
	if (!safeSpace) throw new Error("Photon spaceId is required.");
	if (state !== "start" && state !== "stop") throw new Error('typing state must be "start" or "stop".');
	const token = sidecar.token ?? readSidecarToken(sidecar.envFile);
	const res = await fetch(`${url}/typing`, {
		method: "POST",
		headers: { "Content-Type": "application/json", "X-Photon-Bridge-Token": token },
		body: JSON.stringify({ spaceId: safeSpace, state }),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok || data?.ok === false) {
		throw new Error(`Photon sidecar /typing failed (${res.status}): ${data?.error || res.statusText || "unknown error"}`);
	}
	return { success: true };
}

/**
 * One authenticated sidecar request; used by test_config against POST /healthz.
 */
export async function sidecarRequest(sidecar, path, { method = "POST", body } = {}) {
	const url = String(sidecar?.sidecarUrl || DEFAULT_SIDECAR_URL).replace(/\/+$/, "");
	const token = sidecar.token ?? readSidecarToken(sidecar.envFile);
	const res = await fetch(`${url}${path}`, {
		method,
		headers: { "Content-Type": "application/json", "X-Photon-Bridge-Token": token },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const data = await res.json().catch(() => ({}));
	return { status: res.status, ok: res.ok && data?.ok !== false, data };
}

export async function loadPhotonBotBridge() {
	// Dynamic import with mtime cache-buster: the host only busts index.mjs on
	// plugins_reload; a static ./bridge.mjs import would stay cached in the
	// server process forever and serve stale code after edits.
	const { mtime } = await import("node:fs/promises").then((m) => ({ mtime: m.stat }));
	const bust = (await stat(new URL("./bridge.mjs", import.meta.url))).mtimeMs;
	const mod = await import(new URL(`./bridge.mjs?e=${bust}`, import.meta.url).href);
	return mod.PhotonBotBridge;
}

/** Strip secrets from config before plaintext storage. */
export function stripSecretsFromConfig(cfg) {
	const out = { ...(cfg || {}) };
	delete out.token;
	delete out.sidecarToken;
	return out;
}

/** Merge saved secrets into incoming config. */
export function mergeSavedSecrets(incoming, prev = {}) {
	return { ...(prev || {}), ...(incoming || {}) };
}

export default async function activate(host) {
	let localConfig = (await host.storage.get("config")) || {};
	localConfig = mergeSavedSecrets(localConfig, {});

	const PhotonBotBridge = await loadPhotonBotBridge();
	const botBridge = new PhotonBotBridge({
		helpers: {
			photonSend,
			photonTyping,
			photonSendPoll,
			readSidecarToken,
			cleanIMessageText,
			peerAccountId,
			stripInternalMarkers,
			chunkMarkdownText,
			IMESSAGE_BOT_PREFIX,
			DEFAULT_ALLOWED_USERS,
		},
		host,
		getConfig: () => localConfig,
		log: (lvl, msg) => host.log?.(lvl, msg),
	});

	if (localConfig.botEnabled) {
		botBridge.start().catch((err) => {
			host.log?.("warn", `Photon bot start note: ${err.message}`);
		});
	}

	const sidecarOpts = (cfg) => ({
		sidecarUrl: cfg.sidecarUrl || DEFAULT_SIDECAR_URL,
		envFile: cfg.envFile || DEFAULT_ENV_FILE,
	});

	// Register AI tool "photon" adhering strictly to tool-prompt-hygiene
	host.registerTool?.({
		name: "photon",
		description: "Send text or local file via the Photon iMessage bridge (sidecar on 127.0.0.1:8791).",
		promptSnippet: "send messages via the Photon iMessage bridge",
		promptGuidelines: [
			"Confirm recipient spaceId (e.g. any;-;+8613800000000) and message text with the user once before action=send",
			"Use action=status to query bot connection status",
		],
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: ["send", "status"],
					description: "action to perform (send: send message; status: query connection status).",
				},
				address: {
					type: "string",
					description: "send: target Photon spaceId (DM like any;-;+8613800000000, or a group GUID).",
				},
				file: { type: "string", description: "Absolute path to a local file, image, audio or video attachment." },
				text: {
					type: "string",
					description: "send: message content to send.",
				},
			},
			required: ["action"],
		},
		async execute(args) {
			const action = String(args.action || "");
			switch (action) {
				case "send": {
					const to = args.address?.trim() || localConfig.defaultRecipient?.trim() || DEFAULT_RECIPIENT;
					if (!to) throw new Error("recipient spaceId is required.");
					const sidecar = sidecarOpts(localConfig);
					if (args.file) {
						await photonSendAttachment(sidecar, to, args.file, { caption: "" });
					}
					if (args.text) {
						return JSON.stringify(await photonSend(sidecar, to, args.text), null, 2);
					}
					return JSON.stringify({ success: true }, null, 2);
				}
				case "status": {
					const sidecar = sidecarOpts(localConfig);
					let health = null;
					try {
						const r = await sidecarRequest(sidecar, "/healthz");
						health = { reachable: r.ok, status: r.status, stream: r.data?.stream ?? null };
					} catch (error) {
						health = { reachable: false, error: error.message };
					}
					return JSON.stringify({ bot: botBridge.getStatus(), sidecar: health }, null, 2);
				}
				default:
					throw new Error(`Unknown action: ${action}`);
			}
		},
	});

	// Handle UI client messages
	host.onClientMessage?.(async (msg, reply) => {
		try {
			switch (msg.type) {
				case "get_state": {
					reply({
						type: "state",
						config: {
							sidecarUrl: localConfig.sidecarUrl || DEFAULT_SIDECAR_URL,
							envFile: localConfig.envFile || DEFAULT_ENV_FILE,
							defaultRecipient: localConfig.defaultRecipient || DEFAULT_RECIPIENT,
							workspace: localConfig.workspace || "",
							model: localConfig.model || "",
							thinkingLevel: localConfig.thinkingLevel || "",
							botEnabled: Boolean(localConfig.botEnabled),
							allowedUsers: localConfig.allowedUsers || DEFAULT_ALLOWED_USERS,
						},
						botStatus: botBridge.getStatus(),
						hostCwd: String(host.cwd ?? "").trim(),
					});
					break;
				}

				case "save_config": {
					const incoming = msg.config || {};
					const nextConfig = mergeSavedSecrets(incoming, localConfig);
					await host.storage.set("config", stripSecretsFromConfig(nextConfig));
					localConfig = nextConfig;

					if (localConfig.botEnabled) {
						await botBridge.start();
					} else {
						await botBridge.stop().catch(() => {});
					}

					reply({ type: "save_config_done", success: true, botStatus: botBridge.getStatus() });
					break;
				}

				case "test_config": {
					const sidecar = sidecarOpts(localConfig);
					try {
						const r = await sidecarRequest(sidecar, "/healthz");
						if (r.ok) {
							reply({
								type: "test_config_done",
								success: true,
								message: "环境检测通过：Photon sidecar 可达且 token 校验通过，可经 loopback HTTP 收发 iMessage。",
							});
						} else {
							reply({
								type: "test_config_done",
								success: false,
								message: `Photon sidecar 响应异常（HTTP ${r.status}${r.data?.error ? `：${r.data.error}` : ""}）。请确认 sidecar 正在运行且 env 文件中的 PHOTON_SIDECAR_TOKEN 有效。`,
							});
						}
					} catch (error) {
						reply({
							type: "test_config_done",
							success: false,
							message: `无法连接 Photon sidecar（${sidecar.sidecarUrl}）：${error.message}。请确认 sidecar 已启动，且 env 文件（${sidecar.envFile}，权限 600）存在并可读。`,
						});
					}
					break;
				}

				case "send_message": {
					const to = msg.address?.trim() || localConfig.defaultRecipient?.trim() || DEFAULT_RECIPIENT;
					if (!to) throw new Error("recipient spaceId is required.");
					const sidecar = sidecarOpts(localConfig);
					if (msg.file) {
						await photonSendAttachment(sidecar, to, msg.file, { caption: "" });
					}
					const res = msg.text ? await photonSend(sidecar, to, msg.text) : { success: true };
					reply({ type: "send_done", success: true, res });
					break;
				}

				case "start_bot": {
					localConfig.botEnabled = true;
					await host.storage.set("config", stripSecretsFromConfig(localConfig));
					await botBridge.start();
					reply({ type: "bot_status", success: true, status: botBridge.getStatus() });
					break;
				}

				case "stop_bot": {
					localConfig.botEnabled = false;
					await host.storage.set("config", stripSecretsFromConfig(localConfig));
					await botBridge.stop();
					reply({ type: "bot_status", success: true, status: botBridge.getStatus() });
					break;
				}

				default:
					reply({ type: "error", message: `Unknown message type: ${msg.type}` });
					break;
			}
		} catch (err) {
			reply({ type: "error", message: err.message });
		}
	});

	return async () => {
		await botBridge.stop().catch(() => {});
	};
}
