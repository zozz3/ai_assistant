# Simli P2P 数字人说明

⚠️ 此目录在新的 Simli P2P 方案下不再需要 worker 进程。

旧的 `simli_agent.py`（基于 `livekit-plugins-simli` + LiveKit room）已删除，因为：
1. LiveKit 信令服务器需要额外配置（Cloud 账号或本地 Docker）
2. P2P 模式下浏览器直接与 Simli 云建立 WebRTC，无需中间 SFU

如果将来需要切回 LiveKit 方案，可以参考 git 历史恢复此文件。

数字人初始化流程（当前 P2P 路线）：
- 后端：`/api/avatar/init` 调 Simli `compose-session-token`，返回 `session_token` 给前端
- 前端：使用 `simli-client` npm 包的 `SimliClient(session_token, videoEl, audioEl, iceServers, ..., "p2p")`
- 浏览器 ↔ Simli 云：直连 WebRTC，无 LiveKit
