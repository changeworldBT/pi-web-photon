import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { stat, writeFile, mkdtemp } from "node:fs/promises";
// Helpers are injected by index.mjs instead of imported from it: the host busts
// only index.mjs on reload, so a static ./index.mjs import here would resolve to
// a stale cached instance (missing newly added exports).
let photonSend;
let photonTyping;
let readSidecarToken;
let cleanIMessageText;
let peerAccountId;
let stripInternalMarkers;
let chunkMarkdownText;
let IMESSAGE_BOT_PREFIX;
let DEFAULT_ALLOWED_USERS;
function bindHelpers(helpers) {
	({ photonSend, photonTyping, readSidecarToken, cleanIMessageText, peerAccountId, stripInternalMarkers, chunkMarkdownText, IMESSAGE_BOT_PREFIX, DEFAULT_ALLOWED_USERS } = helpers);
}
const THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);
/** iMessage typing bubbles expire ~60s; refresh comfortably inside that. */
const TYPING_REFRESH_MS = 45_000;

// No public inbound API from Photon: consume the local sidecar's GET /inbound
// NDJSON long stream (blank lines are heartbeats); never talk to the cloud directly.
const RECONNECT_DELAY_MAX_MS = 30000;
const EXT_BY_MIME = {
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/gif": ".gif",
	"image/webp": ".webp",
	"audio/mp4": ".m4a",
	"audio/mpeg": ".mp3",
	"audio/wav": ".wav",
	"audio/ogg": ".ogg",
	"video/mp4": ".mp4",
	"video/quicktime": ".mov",
	"application/pdf": ".pdf",
	"text/plain": ".txt",
	"application/json": ".json",
};

export class PhotonBotBridge {
	/** @param {{host?: any, getConfig?: any, log?: any, fetchImpl?: any, platform?: string}} options */
	constructor({ host, getConfig, log, fetchImpl, platform = process.platform } = {}) {
		if (arguments[0]?.helpers) bindHelpers(arguments[0].helpers);
		Object.assign(this, { host, getConfig, fetchImpl });
		this.log = log || (() => {});
		this.running = false;
		this.abortController = null;
		this.reconnectTimer = null;
		this.reconnectDelay = 1000;
		this.streamBuffer = "";
		this.offRunEvent = null;
		this.seenMessageIds = new Set();
		this.pendingRuns = new Map();
		this.earlyRuns = new Map();
		this.dispatches = 0;
		this.typingHandles = new Map();
		this.generation = 0;
		this.userConversations = new Map();
		this.userWorkspaces = new Map();
		this.settings = new Map();
		this.sessionEpochs = new Map();
		this.cancelEpochs = new Map();
		this.queues = new Map();
		this.status = {
			enabled: false,
			connected: false,
			state: "idle",
			platform,
			messagesReceived: 0,
			messagesReplied: 0,
			lastError: null,
		};
	}
	getStatus() {
		return { ...this.status };
	}
	resolveWorkspace(key, cfg) {
		return this.userWorkspaces.get(key) || cfg.workspace || this.host.cwd || "";
	}
	sidecarUrl() {
		return String(this.getConfig()?.sidecarUrl || "http://127.0.0.1:8791").replace(/\/+$/, "");
	}
	sidecarToken() {
		return readSidecarToken(this.getConfig()?.envFile);
	}
	/** Sidecar handle for send/typing calls (url + token source). */
	sidecarHandle() {
		return { sidecarUrl: this.sidecarUrl(), envFile: this.getConfig()?.envFile };
	}
	/**
	 * Start the "typing…" bubble for a space and keep it alive. iMessage drops
	 * the indicator after ~60s, so refresh well inside that window. Returns a
	 * stop() that cancels the refresh and clears the bubble.
	 */
	beginTyping(target) {
		const space = String(target || "").trim();
		if (!space) return () => {};
		const existing = this.typingHandles.get(space);
		if (existing) return existing;
		const sidecar = this.sidecarHandle();
		const ping = () => {
			photonTyping(sidecar, space, "start").catch((error) => {
				this.log("warn", `typing indicator failed: ${error.message}`);
			});
		};
		ping();
		const timer = setInterval(ping, TYPING_REFRESH_MS);
		timer.unref?.();
		const stop = () => {
			clearInterval(timer);
			this.typingHandles.delete(space);
			photonTyping(sidecar, space, "stop").catch(() => {});
		};
		this.typingHandles.set(space, stop);
		return stop;
	}
	async reply(target, text) {
		try {
			await photonSend({ sidecarUrl: this.sidecarUrl(), envFile: this.getConfig()?.envFile }, target, IMESSAGE_BOT_PREFIX + text);
		} catch (error) {
			this.status.lastError = error.message;
			this.log("warn", `Photon iMessage delivery failed: ${error.message}`);
			throw error;
		}
	}
	async start() {
		if (this.running) return;
		this.status.enabled = true;
		this.running = true;
		this.reconnectDelay = 1000;
		this.offRunEvent = this.host.onRunEvent?.((ev) => this.handleRunEvent(ev));
		this.connectLoop().catch((error) => {
			this.status.state = "error";
			this.status.lastError = error.message;
		});
	}
	async stop() {
		this.generation++;
		this.running = false;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		this.streamBuffer = "";
		try {
			this.abortController?.abort();
		} catch {}
		this.abortController = null;
		this.offRunEvent?.();
		this.offRunEvent = null;
		this.pendingRuns.clear();
		this.earlyRuns.clear();
		for (const stop of [...this.typingHandles.values()]) {
			try {
				stop();
			} catch {
				/* best effort */
			}
		}
		this.typingHandles.clear();
		this.status.enabled = false;
		this.status.connected = false;
		this.status.state = "idle";
	}
	async connectLoop() {
		while (this.running) {
			this.abortController = new AbortController();
			try {
				const res = await (this.fetchImpl || fetch)(`${this.sidecarUrl()}/inbound`, {
					headers: { Accept: "application/x-ndjson", "X-Photon-Bridge-Token": this.sidecarToken() },
					signal: this.abortController.signal,
				});
				if (!res.ok || !res.body) throw new Error(`sidecar /inbound returned HTTP ${res.status}`);
				this.status.connected = true;
				this.status.state = "connected";
				this.status.lastError = null;
				this.reconnectDelay = 1000;
				await this.consumeStream(res.body);
			} catch (error) {
				if (this.abortController?.signal.aborted || !this.running) return;
				this.status.connected = false;
				this.status.state = "reconnecting";
				this.status.lastError = error.message;
				this.log("warn", `Photon inbound stream dropped, retrying in ${this.reconnectDelay}ms: ${error.message}`);
				await new Promise((r) => {
					this.reconnectTimer = setTimeout(r, this.reconnectDelay);
					this.reconnectTimer.unref?.();
				});
				this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_DELAY_MAX_MS);
			} finally {
				this.abortController = null;
			}
		}
	}
	async consumeStream(body) {
		const decoder = new TextDecoder();
		this.streamBuffer = "";
		for await (const chunk of body) {
			if (!this.running) return;
			this.streamBuffer += decoder.decode(chunk, { stream: true });
			let newline;
			while ((newline = this.streamBuffer.indexOf("\n")) >= 0) {
				const line = this.streamBuffer.slice(0, newline).replace(/\r$/, "");
				this.streamBuffer = this.streamBuffer.slice(newline + 1);
				if (!line.trim()) continue;
				let event;
				try {
					event = JSON.parse(line);
				} catch (error) {
					this.log("warn", `Photon inbound stream: skipping malformed NDJSON line: ${error.message}`);
					continue;
				}
				void this.onInboundMessage(event).catch((error) => this.log("warn", error.message));
			}
		}
		if (!this.running) return;
		throw new Error("sidecar /inbound stream ended");
	}
	async writeTempAttachment(data, name, mimeType) {
		const dir = await mkdtemp(join(tmpdir(), "photon-inbound-"));
		const ext = (String(name || "").match(/\.[A-Za-z0-9]{1,8}$/) || [EXT_BY_MIME[String(mimeType || "").toLowerCase()] || ".bin"])[0];
		const path = join(dir, `attachment${ext}`);
		await writeFile(path, Buffer.from(String(data), "base64"));
		return path;
	}
	onInboundMessage(event) {
		const sender = String(event?.sender?.id || "").trim();
		if (!sender) return Promise.resolve();
		const room = String(event?.space?.id || sender),
			key = JSON.stringify([room, sender]);
		const target = room;
		if (/^\/(stop|abort)(?:\s|$)/i.test(String(this.eventText(event) || "").trim())) {
			return this.receive(event, { sender, key, target });
		}
		const previous = this.queues.get(key) || Promise.resolve();
		const next = previous.catch(() => {}).then(() => this.receive(event, { sender, key, target }));
		this.queues.set(key, next);
		return next.finally(() => {
			if (this.queues.get(key) === next) this.queues.delete(key);
		});
	}
	eventText(event) {
		const content = event?.content;
		if (!content || typeof content !== "object") return "";
		if (content.type === "text") return String(content.text || "");
		if (content.type === "group") {
			const items = Array.isArray(content.items) ? content.items : [];
			return items
				.map((item) => (item?.content?.type === "text" ? String(item.content.text || "") : ""))
				.filter(Boolean)
				.join("\n");
		}
		return "";
	}
	async receive(event, { sender, key, target }) {
		const generation = this.generation;
		const id = event?.messageId;
		if (id) {
			if (this.seenMessageIds.has(id)) return;
			this.seenMessageIds.add(id);
			if (this.seenMessageIds.size > 1000) this.seenMessageIds.delete(this.seenMessageIds.values().next().value);
		}
		const cfg = this.getConfig() || {},
			allowed = cfg.allowedUsers || DEFAULT_ALLOWED_USERS;
		if (allowed.length && !allowed.includes(sender)) {
			await this.reply(target, "访问受限：您不在白名单中。");
			return;
		}
		const content = event?.content;
		if (content?.type === "read" || content?.type === "reaction") return;
		const text = cleanIMessageText(this.eventText(event));
		if (this.eventText(event).startsWith(IMESSAGE_BOT_PREFIX)) return;
		this.status.messagesReceived++;
		if (text.startsWith("/")) {
			await this.command(text, { key, target, cfg });
			return;
		}
		// Acknowledge receipt visually: the bubble shows up while we still read
		// attachments and before the model starts, so the sender can tell the
		// bridge is alive rather than dead.
		const stopTyping = this.beginTyping(target);
		let typingOwnedByRun = false;
		try {
			const cancelEpoch = this.cancelEpochs.get(key) || 0;
			const attachments = [];
			let imageBytes = 0,
				imageCount = 0;
			const contentItems =
				content?.type === "group" ? (Array.isArray(content.items) ? content.items : []).map((item) => item?.content) : content ? [content] : [];
			for (const item of contentItems) {
				if (!item || typeof item !== "object") continue;
				if (item.type === "text" || item.type === "richlink") continue;
				if (item.type !== "attachment" && item.type !== "voice") {
					await this.reply(
						target,
						`不支持或无法识别的附件类型：${String(item?.type || "未知类型")}。请发送文字、PNG/JPEG/GIF/WebP 图片或常见文件。`,
					);
					continue;
				}
				const mime = String(item.mimeType || "");
				if (!item.data) {
					await this.reply(target, `附件过大或未携带内容（超过 sidecar 内联上限），无法读取：${String(item.name || "未命名")}`);
					return;
				}
				try {
					const path = await this.writeTempAttachment(item.data, item.name, mime);
					const name = String(item.name || path.split(/[\\/]/).pop());
					if (item.type !== "voice" && /^image\/(png|jpeg|gif|webp)$/.test(mime)) {
						const info = await stat(path);
						if (info.size > 10 * 1024 * 1024) throw new Error("image exceeds 10 MiB");
						if (++imageCount > 8 || (imageBytes += info.size) > 20 * 1024 * 1024)
							throw new Error("images exceed 8 items or 20 MiB total");
						attachments.push({ path: "", imageData: item.data, mimeType: mime, name });
					} else if (item.type === "voice" || /^(audio\/|video\/|text\/|application\/)/.test(mime)) {
						attachments.push({ path, mode: "reference", name });
						if (item.type === "voice" || /^(audio|video)\//.test(mime))
							await this.reply(
								target,
								"已接收音视频文件，将作为附件交给模型；是否能转录或理解取决于模型与可用工具，不保证自动解码。",
							);
					} else {
						await this.reply(
							target,
							`不支持或无法识别的附件类型：${mime || "未知类型"}。请发送文字、PNG/JPEG/GIF/WebP 图片或常见文件。`,
						);
					}
				} catch (error) {
					await this.reply(target, `附件读取失败：${error.message}`);
					return;
				}
			}
			if (generation !== this.generation || cancelEpoch !== (this.cancelEpochs.get(key) || 0)) return;
			if (!text && !attachments.length) {
				if (!contentItems.length) await this.reply(target, "此消息无可读取正文（可能为 Apple 富文本），请重发为纯文本。");
				return;
			}
			if ([...this.pendingRuns.values()].some((r) => r.key === key)) {
				await this.reply(target, "当前会话仍在运行，请等待完成或使用 /stop。");
				return;
			}
			const run = { key, target, text: "", conversationId: this.userConversations.get(key), runId: null, stopTyping };
			this.dispatches++;
			try {
				const opts = this.settings.get(key) || {};
				const receipt = await this.host.chat({
					text: text || "请查看附件",
					accountId: peerAccountId(`${key}:${this.sessionEpochs.get(key) || 0}`),
					...(run.conversationId ? { conversationId: run.conversationId } : {}),
					cwd: this.resolveWorkspace(key, cfg),
					...(cfg.model ? { model: cfg.model } : {}),
					...(cfg.thinkingLevel ? { thinkingLevel: cfg.thinkingLevel } : {}),
					...opts,
					...(attachments.length ? { attachments } : {}),
				});
				if (generation !== this.generation) return;
				if (cancelEpoch !== (this.cancelEpochs.get(key) || 0)) {
					if (receipt?.conversationId) await this.host.abortRun?.(receipt.runId || receipt.conversationId);
					return;
				}
				if (!receipt?.conversationId) throw new Error("Host returned no conversation ID");
				run.conversationId = receipt.conversationId;
				run.runId = receipt.runId;
				this.userConversations.set(key, receipt.conversationId);
				const token = receipt.runId || receipt.conversationId;
				this.pendingRuns.set(token, run);
				typingOwnedByRun = true;
				const early = this.earlyRuns.get(token) || [];
				this.earlyRuns.delete(token);
				for (const ev of early) await this.handleRunEvent(ev);
			} catch (error) {
				if (generation !== this.generation) return;
				await this.reply(target, `任务启动失败：${error.message}`);
			} finally {
				this.dispatches--;
				if (!this.dispatches) this.earlyRuns.clear();
			}
		} finally {
			if (!typingOwnedByRun) stopTyping();
		}
	}
	async command(text, { key, target, cfg }) {
		const [raw, ...parts] = text.split(/\s+/),
			cmd = raw.toLowerCase(),
			arg = parts.join(" ").trim();
		const opts = this.settings.get(key) || {};
		switch (cmd) {
			case "/help":
				await this.reply(
					target,
					"/help /new /clear /status /stop (/abort) /model [provider/id] /thinking [off|minimal|low|medium|high|xhigh] /cwd [目录]。图片支持 PNG/JPEG/GIF/WebP；语音、视频及文件不自动转录。",
				);
				return;
			case "/model":
				if (arg) {
					if (!/^[^\s/]+\/\S+$/.test(arg)) {
						await this.reply(target, "用法：/model provider/id");
						return;
					}
					opts.model = arg;
					this.settings.set(key, opts);
				}
				await this.reply(target, `模型：${opts.model || cfg.model || "跟随宿主"}（下次运行生效）`);
				return;
			case "/thinking":
				if (arg) {
					if (!THINKING.has(arg)) {
						await this.reply(target, "思考强度应为 off|minimal|low|medium|high|xhigh");
						return;
					}
					opts.thinkingLevel = arg;
					this.settings.set(key, opts);
				}
				await this.reply(target, `思考强度：${opts.thinkingLevel || cfg.thinkingLevel || "跟随宿主"}（下次运行生效）`);
				return;
			case "/stop":
			case "/abort": {
				this.cancelEpochs.set(key, (this.cancelEpochs.get(key) || 0) + 1);
				const run = [...this.pendingRuns.values()].find((r) => r.key === key);
				if (!run) {
					await this.reply(target, "已取消正在准备的请求；当前没有已启动的任务。");
					return;
				}
				const result = await this.host.abortRun?.(run.runId || run.conversationId);
				await this.reply(target, result?.ok ? "已请求停止。" : `停止失败：${result?.error || "宿主不支持中止"}`);
				return;
			}
			case "/cwd":
			case "/workspace":
				if (!arg) {
					await this.reply(target, `工作目录：${this.resolveWorkspace(key, cfg)}`);
					return;
				}
				try {
					if (!(await stat(arg)).isDirectory()) throw new Error("不是目录");
				} catch (error) {
					await this.reply(target, `目录无效：${error.message}`);
					return;
				}
				break;
			case "/new":
			case "/clear":
				break;
			case "/status":
				await this.reply(
					target,
					`状态：${this.status.state}\n会话：${this.userConversations.get(key) || "尚未创建"}\n运行中：${[...this.pendingRuns.values()].some((r) => r.key === key)}\n最近错误：${this.status.lastError || "无"}`,
				);
				return;
			default:
				await this.reply(target, "未知命令。发送 /help 查看支持的命令。");
				return;
		}
		if ([...this.pendingRuns.values()].some((r) => r.key === key)) {
			await this.reply(target, "请先 /stop 并等待任务结束后再切换会话或目录。");
			return;
		}
		if (arg && (cmd === "/cwd" || cmd === "/workspace")) this.userWorkspaces.set(key, resolve(arg));
		this.userConversations.delete(key);
		this.sessionEpochs.set(key, (this.sessionEpochs.get(key) || 0) + 1);
		await this.reply(target, "已开启新会话（不删除历史）；将在下条消息创建。");
	}
	async handleRunEvent(ev) {
		const token = ev.runId || ev.conversationId;
		if (!token) return;
		const run = this.pendingRuns.get(token);
		if (!run) {
			if (this.dispatches) {
				if (!this.earlyRuns.has(token) && this.earlyRuns.size >= 64) return;
				const list = this.earlyRuns.get(token) || [];
				if (list.length < 256) {
					list.push(ev);
					this.earlyRuns.set(token, list);
				}
			}
			return;
		}
		if (ev.conversationId) run.conversationId = ev.conversationId;
		if (ev.type === "message" && (ev.message?.role === "assistant" || ev.message?.author === "assistant")) {
			const content = ev.message.content;
			run.text +=
				(run.text ? "\n" : "") +
				(typeof content === "string"
					? content
					: Array.isArray(content)
						? content
								.filter((c) => c.type === "text" || typeof c === "string")
								.map((c) => (typeof c === "string" ? c : c.text || ""))
								.join("\n")
						: "");
		}
		if (ev.type !== "run_end") return;
		this.pendingRuns.delete(token);
		try {
			run.stopTyping?.();
		} catch {
			/* best effort */
		}
		this.userConversations.set(run.key, run.conversationId);
		const text =
			stripInternalMarkers(run.text) ||
			(ev.error
				? `任务失败：${ev.error}`
				: ev.stopReason === "aborted"
					? "任务已停止。"
					: "任务完成，无文本输出。附件不会自动发送，请使用 photon 工具的 file 参数。");
		for (const chunk of chunkMarkdownText(text, 3000)) await this.reply(run.target, chunk);
		this.status.messagesReplied++;
	}
}
