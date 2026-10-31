# Photon iMessage

通过本机 Photon sidecar 的 loopback HTTP 接口收发 iMessage：发消息走 `POST /send`、`POST /send-attachment`，收消息走 `GET /inbound` NDJSON 长连接流。运行 pi-web-ui 的机器只须是 Linux（或任何能跑 Node 的系统），无须 macOS、无须 Apple 自动化授权。

## 架构

```
pi-web-ui 插件（本目录）
    │  loopback HTTP（X-Photon-Bridge-Token 鉴权）
    ▼
Photon sidecar（node，spectrum-ts SDK）
    │  gRPC
    ▼
Photon 云（Spectrum 平台）
    │
    ▼
iMessage（iPhone / iPad / Mac）
```

插件与 sidecar 之间只经 `127.0.0.1` loopback 通信，token 一律从 env 文件实时解析，不写入插件 storage。

## 运行条件

- sidecar 已在本机运行并监听 `PHOTON_SIDECAR_PORT`（默认 `8791`），且 `~/.photon-sidecar/env`（权限 600）存在，内含 `PHOTON_PROJECT_ID`、`PHOTON_PROJECT_SECRET`、`PHOTON_SIDECAR_PORT`、`PHOTON_SIDECAR_TOKEN`（KEY=VALUE 行）。
- Photon 项目使用免费档时，**只能回复已有会话**（用户先发来消息、拿到 spaceId 后回复），不能主动向陌生号码外发；sidecar 会以 `target not allowed` 类错误拒绝，属计划限制而非故障。
- 发送失败会在会话与状态中明确报错，不伪装成功。

## 交互反馈

收到白名单用户的消息后，插件会立刻在对话里点亮「正在输入…」气泡（iMessage 约 60s 过期，插件每 45s 续期），任务结束或出错时自动熄灭，便于确认桥接是否在线。

## 配置

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `sidecarUrl` | `http://127.0.0.1:8791` | sidecar loopback 地址 |
| `envFile` | `~/.photon-sidecar/env` | token 解析来源（KEY=VALUE） |
| `defaultRecipient` | `any;-;+8618657150392` | 未指定目标时使用的默认 spaceId（家频道） |
| `botEnabled` | `false` | 启用双向机器人（消费 /inbound 流） |
| `allowedUsers` | `["+8618657150392"]` | 发送者白名单，留空不限制 |
| `workspace` | 空 | 机器人执行项目根目录，聊天内可用 /cwd 切换 |
| `model` | 空 | 覆盖全局默认模型 |
| `thinkingLevel` | 空 | 覆盖全局思考强度 |

## 命令

支持 `/help`、`/new`、`/clear`、`/status`、`/stop`（`/abort`）、`/model [provider/id]`、`/thinking [off|minimal|low|medium|high|xhigh]`、`/cwd [目录]`。`/workspace` 为兼容别名。未知命令及无效参数直接反馈，不送模型。

`/new` 与 `/clear` 创建新上下文，不删除历史；运行中须先停止并等待结束再切换。模型、思考强度和工作目录按「spaceId + 发送者」隔离，设置在下一次运行生效；宿主拒绝模型/目录会反馈启动失败。会话关联使用宿主真实 conversationId 和稳定 runId，支持早于 chat 回执到达的结束事件及会话过户。

## 媒体

入站 attachment / voice 内容由 sidecar 以 base64 内联在 NDJSON 事件里；插件落盘为 `/tmp` 下的临时文件后交给宿主。PNG/JPEG/GIF/WebP 图片以真实 `attachments.imageData` 传给宿主：最多 8 张，单张 10 MiB，总计 20 MiB；HEIC 等未知或不支持图像明确反馈，不伪装为已理解。音频、视频、文本及常见 application 文件以绝对本地路径 reference 附件送入宿主；音视频会提示「是否可转录/理解取决于模型与工具」。附件读取失败会回复错误。超过 sidecar 内联上限的附件会收到明确提示。

群聊消息按 spaceId 与发送者隔离会话；回复定向回原 space。

AI `photon` 工具和插件 `send_message` 接口支持 `file` 本地路径，可与 `text` 一起发送。助手输出的文件不会自动发送，应明确调用工具。

## 可靠性

`/inbound` 流断开时以 1s 起步、30s 封顶的指数退避重连，期间状态显示 `reconnecting`；以 messageId 去重，重连后 sidecar 的 catch-up 重放不会导致重复处理。停机期间到达的消息由 sidecar 缓冲（无消费者时不拉取），重连后补投。

## 验证范围

命令、早到事件、runId 归属、跨 space、图片附件、文件引用、/send 与 /send-attachment 请求形状、NDJSON 解析和错误反馈均有模拟行为测试。真实端到端验证仍需 sidecar 凭据与 Photon 项目在线。
