# coding=utf-8
"""
API路由定义
"""
import asyncio
import base64
import json
import logging
import os
import time
import uuid
from datetime import datetime as _dt
from typing import Optional, Dict, Any

import httpx

from fastapi import APIRouter, HTTPException, UploadFile, File, Form, Depends, WebSocket, WebSocketDisconnect

from .models import (
    VoiceRequest, VoiceResponse, TextRequest, TextResponse,
    AvatarInitRequest, AvatarInitResponse, ChatHistoryRequest,
    ChatHistoryResponse, ChatMessage, ErrorResponse, HealthResponse,
    PipelineEvent, PipelineEventType,
)
from services.asr_service import (
    ASRService,
    StreamASRSession,
    create_stream_session,
    get_stream_session,
    remove_stream_session,
)
from services.llm_service import LLMService
from services.tts_service import TTSService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api")

# 服务实例
asr_service = ASRService()
llm_service = LLMService()
tts_service = TTSService()


def _append_history_and_trim(session_id: str, msg: ChatMessage, max_history: int = 20) -> None:
    """
    向 session 历史追加一条消息，并保持滑动窗口大小。

    Args:
        session_id: 会话 ID
        msg: 待追加的消息
        max_history: 保留的最大消息数（默认 20 = 10 轮 user/assistant 对话）。
                     超出的最早消息会被丢弃，避免 LLM 上下文无限增长导致：
                       - token 成本线性上涨
                       - 响应延迟累积
                       - 超出模型 max_tokens 限制
    """
    from datetime import datetime as _dt
    now_iso = _dt.utcnow().isoformat()
    # 读完整历史（磁盘 + 内存）
    full_history = get_session_messages(session_id)
    # 转成 dict 方便统一处理（ChatMessage 没 timestamp 字段也能兼容）
    new_entry = {
        "role": msg.role,
        "content": msg.content,
        "timestamp": msg.timestamp or now_iso,
    }
    full_history.append(new_entry)
    # ✅ 同时更新内存 LLM 用滑动窗口（最近 20 条 = LLM 上下文）
    llm_window = full_history[-max_history:]
    chat_sessions[session_id] = llm_window
    # ✅ 持久化完整历史到磁盘（写盘可能慢，但有线程锁，调用线程不阻塞）
    _save_session(session_id, full_history)
    # ✅ 更新 session 元数据（自动生成 title 等）
    try:
        _update_session_meta_on_message(session_id, msg.role, msg.content)
    except Exception as e:
        logger.warning(f"[SessionMeta] update failed: {e}")


def _get_runtime_asr_config() -> Dict[str, Any]:
    """
    从 config_service 读 ASR 运行时配置（用户在前端设置页面保存的）。
    这样后端真正使用的 key / workspace_id / model 才会和前端一致，
    而不是去读 .env 里的占位值。
    """
    try:
        from services.config_service import config_service
        cfg = config_service.get_config("asr")
        # 兜底：config_service 默认值里也有 api_key 字段，做个安全合并
        if not cfg.get("api_key"):
            cfg["api_key"] = os.getenv("DASHSCOPE_API_KEY", "").strip()
        return cfg
    except Exception as e:
        logger.warning(f"读 config_service['asr'] 失败，回退到 .env: {e}")
        return {
            "api_key": os.getenv("DASHSCOPE_API_KEY", "").strip(),
            "model": "qwen-audio-3.1-asr-flash",
            "workspace_id": os.getenv("DASHSCOPE_WORKSPACE_ID", "").strip(),
            "language": "en",
            "sample_rate": 16000,
            "format": "wav",
        }

# 会话存储（持久化到磁盘，进程重启/页面刷新后仍保留完整对话历史）
# 结构：{ session_id: [ {role, content, timestamp}, ... ] }
# 每个 session 各自维护一条滑动窗口（最近 max_history 条），但磁盘保存用户的所有发言，
# 这样"持久化" + "LLM 上下文控制" 互不冲突。
import json as _json
import threading as _threading
from pathlib import Path as _Path

_CHAT_HISTORY_DIR = _Path(__file__).parent.parent / "chat_history_data"
_CHAT_HISTORY_DIR.mkdir(exist_ok=True)
_MAX_HISTORY_DISK = 200  # 每个 session 在磁盘上保留的最大消息数（远大于 LLM 滑动窗口）

# ===== Session 元数据（独立文件，方便"历史对话侧边栏"用）=====
# 文件格式：{session_id}.meta.json
# 内容：{
#   "session_id": "xxx",
#   "title": "前 30 字",   ← 首条 user 消息自动生成
#   "scene": "daily" | "interview",
#   "created_at": "ISO 8601",
#   "updated_at": "ISO 8601",
#   "message_count": N,
#   "grammar_checks": [  ← 累积每次的纠错历史
#     {
#       "message_id": "user-msg-id",
#       "user_text": "I goes to school",
#       "checks": [
#         {"original": "I goes", "corrected": "I go", "explanation": "..."}
#       ],
#       "created_at": "ISO 8601"
#     }
#   ]
# }

_write_lock = _threading.Lock()


def _session_file_path(session_id: str) -> _Path:
    # session_id 可能含特殊字符，做 hash 化保证文件名安全
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in session_id)
    return _CHAT_HISTORY_DIR / f"{safe}.json"


def _load_session(session_id: str) -> list:
    """从磁盘读一个 session 的历史。"""
    path = _session_file_path(session_id)
    if not path.exists():
        return []
    try:
        raw = _json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(raw, list):
            return []
        # 兼容旧数据：缺 timestamp 的补当前时间
        from datetime import datetime as _dt
        for m in raw:
            if isinstance(m, dict) and "timestamp" not in m:
                m["timestamp"] = _dt.utcnow().isoformat()
        return raw
    except Exception as e:
        logger.warning(f"[ChatHistory] 加载 {session_id} 失败: {e}")
        return []


def _save_session(session_id: str, messages: list) -> None:
    """把 session 的历史写入磁盘（线程安全、裁剪）。"""
    with _write_lock:
        try:
            # 裁剪磁盘保留量
            trimmed = messages[-_MAX_HISTORY_DISK:]
            _session_file_path(session_id).write_text(
                _json.dumps(trimmed, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except Exception as e:
            logger.warning(f"[ChatHistory] 持久化 {session_id} 失败: {e}")


def get_session_messages(session_id: str) -> list:
    """对外：读 session 完整历史（磁盘 + 内存缓存合并）。"""
    if session_id not in chat_sessions:
        chat_sessions[session_id] = _load_session(session_id)
    return chat_sessions[session_id]


chat_sessions: dict = {}


# 启动时批量加载已有 session（让前端刷新后能立即看到历史）
def _bootstrap_sessions_from_disk() -> None:
    count = 0
    for path in _CHAT_HISTORY_DIR.glob("*.json"):
        try:
            sid = path.stem
            data = _json.loads(path.read_text(encoding="utf-8"))
            if isinstance(data, list):
                chat_sessions[sid] = data
                count += 1
        except Exception:
            continue
    if count:
        logger.info(f"[ChatHistory] 从磁盘加载 {count} 个 session")


_bootstrap_sessions_from_disk()


@router.get("/health", response_model=HealthResponse)
async def health_check():
    """健康检查接口"""
    return HealthResponse(
        status="healthy",
        version="1.0.0",
        services={
            "asr": "online" if asr_service.is_available() else "offline",
            "llm": "online" if llm_service.is_available() else "offline",
            "tts": "online" if tts_service.is_available() else "offline"
        }
    )


# ==================== 流式 ASR WebSocket ====================

@router.websocket("/asr/stream")
async def asr_stream_ws(websocket: WebSocket):
    """
    流式 ASR WebSocket 端点（对齐阿里云官方 Quick Start）

    协议：
      客户端 → 服务端（JSON）
        {"type": "start", "session_id": "xxx", "language": "en",
         "format": "pcm", "sample_rate": 16000,
         "streaming_model": "qwen-audio-3.0-asr-flash-streaming",
         "workspace_id": "optional"}
        {"type": "audio", "data": "<base64 PCM int16 帧>"}
        {"type": "stop"}

      服务端 → 客户端（JSON）
        {"type": "ready"}
        {"type": "open", "session_id": "..."}
        {"type": "partial", "text": "..."}
        {"type": "sentence_end", "text": "Hello world."}
        {"type": "complete", "text": "...", "metrics": {...}}
        {"type": "error", "message": "..."}
    """
    await websocket.accept()
    session_id: Optional[str] = None
    stream_session: Optional[StreamASRSession] = None
    loop = asyncio.get_running_loop()

    async def send(payload: dict):
        try:
            await websocket.send_text(json.dumps(payload, ensure_ascii=False))
        except Exception:
            pass

    async def send_thread_safe(payload: dict):
        """从识别回调线程中安全地发送消息"""
        await loop.run_in_executor(None, lambda: None)  # 让出
        try:
            await websocket.send_text(json.dumps(payload, ensure_ascii=False))
        except Exception:
            pass

    try:
        await send({"type": "ready"})

        while True:
            try:
                raw = await websocket.receive_text()
            except WebSocketDisconnect:
                logger.info("[ASR-WS] client disconnected, session=%s", session_id)
                break
            except Exception as e:
                logger.warning("[ASR-WS] receive error: %s", e)
                break

            try:
                msg = json.loads(raw)
            except Exception:
                await send({"type": "error", "message": "invalid JSON"})
                continue

            mtype = msg.get("type")

            if mtype == "start":
                session_id = msg.get("session_id") or f"asr_{uuid.uuid4().hex[:12]}"
                language = msg.get("language", "en")
                audio_format = msg.get("format", "pcm")
                try:
                    sample_rate = int(msg.get("sample_rate", 16000))
                except Exception:
                    sample_rate = 16000
                streaming_model = msg.get("streaming_model", "qwen-audio-3.0-asr-flash-streaming")
                workspace_id = msg.get("workspace_id") or None

                loop = asyncio.get_running_loop()

                def _partial(text: str):
                    asyncio.run_coroutine_threadsafe(
                        send({"type": "partial", "text": text, "session_id": session_id}),
                        loop,
                    )

                def _sentence_end(text: str):
                    asyncio.run_coroutine_threadsafe(
                        send({"type": "sentence_end", "text": text, "session_id": session_id}),
                        loop,
                    )

                def _complete():
                    pass  # onclose 内统计

                def _error(err_msg: str):
                    asyncio.run_coroutine_threadsafe(
                        send({"type": "error", "message": err_msg}),
                        loop,
                    )

                def _open():
                    asyncio.run_coroutine_threadsafe(
                        send({"type": "open", "session_id": session_id}),
                        loop,
                    )

                def _close():
                    metrics = stream_session.get_metrics() if stream_session else {}
                    text = stream_session.get_full_text() if stream_session else ""
                    asyncio.run_coroutine_threadsafe(
                        send({
                            "type": "complete",
                            "session_id": session_id,
                            "text": text,
                            "metrics": metrics,
                        }),
                        loop,
                    )

                stream_session = create_stream_session(
                    session_id=session_id,
                    on_partial=_partial,
                    on_sentence_end=_sentence_end,
                    on_complete=_complete,
                    on_error=_error,
                    on_open=_open,
                    on_close=_close,
                    model=streaming_model,
                    format=audio_format,
                    sample_rate=sample_rate,
                    language=language,
                    workspace_id=workspace_id,
                )
                try:
                    stream_session.start()
                except Exception as e:
                    logger.exception("start failed")
                    await send({"type": "error", "message": f"start failed: {e}"})
                    remove_stream_session(session_id)
                    stream_session = None
                continue

            if mtype == "audio":
                if not stream_session:
                    await send({"type": "error", "message": "未启动流式识别，请先发送 start"})
                    continue
                data_b64 = msg.get("data")
                if not data_b64:
                    continue
                try:
                    raw_bytes = base64.b64decode(data_b64)
                    # DashScope 期望 int16 PCM 字节流 - 我们假设客户端已按要求采样
                    stream_session.send_audio_frame(raw_bytes)
                except Exception as e:
                    logger.exception("audio frame error")
                    await send({"type": "error", "message": f"audio frame error: {e}"})
                continue

            if mtype == "stop":
                if stream_session:
                    try:
                        stream_session.stop()
                    except Exception:
                        logger.exception("stop failed")
                    text = stream_session.get_full_text()
                    metrics = stream_session.get_metrics()
                    await send({
                        "type": "complete",
                        "session_id": session_id,
                        "text": text,
                        "metrics": metrics,
                    })
                    remove_stream_session(session_id or "")
                continue

            if mtype == "ping":
                await send({"type": "pong", "ts": time.time()})
                continue

            await send({"type": "error", "message": f"unknown message type: {mtype}"})

    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.exception("ASR WebSocket error")
        try:
            await send({"type": "error", "message": str(e)})
        except Exception:
            pass
    finally:
        if stream_session:
            try:
                stream_session.stop()
            except Exception:
                pass
            if session_id:
                remove_stream_session(session_id)


@router.post("/chat/voice", response_model=VoiceResponse)
async def voice_chat(request: VoiceRequest):
    """
    语音对话接口
    完整链路：语音输入 -> ASR -> LLM -> TTS
    """
    try:
        # 1. ASR语音识别
        audio_bytes = base64.b64decode(request.audio_data)
        recognized_text = await asr_service.recognize(
            audio_bytes, 
            format=request.format or "wav",
            sample_rate=request.sample_rate or 16000
        )
        
        if not recognized_text:
            raise HTTPException(status_code=400, detail="无法识别语音内容")
        
        # 获取或创建会话
        session_id = request.session_id or f"session_{hash(recognized_text)}"
        if session_id not in chat_sessions:
            chat_sessions[session_id] = []
        
        # 添加用户消息到历史（带滑动窗口裁剪）
        _append_history_and_trim(session_id, ChatMessage(role="user", content=recognized_text))
        
        # 2. LLM对话处理
        reply_text = await llm_service.chat(
            messages=chat_sessions[session_id],
            session_id=session_id
        )
        
        # 添加AI回复到历史（带滑动窗口裁剪）
        _append_history_and_trim(session_id, ChatMessage(role="assistant", content=reply_text))
        
        # 3. TTS语音合成
        audio_data = await tts_service.synthesize(reply_text)
        audio_base64 = base64.b64encode(audio_data).decode('utf-8') if audio_data else None
        
        return VoiceResponse(
            text=recognized_text,
            reply_text=reply_text,
            audio_data=audio_base64,
            session_id=session_id
        )
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/chat/text", response_model=TextResponse)
async def text_chat(request: TextRequest):
    """
    文本对话接口
    """
    try:
        # 获取或创建会话
        session_id = request.session_id or f"session_{hash(request.text)}"
        if session_id not in chat_sessions:
            chat_sessions[session_id] = []
        
        # 添加用户消息到历史（带滑动窗口裁剪）
        _append_history_and_trim(session_id, ChatMessage(role="user", content=request.text))
        
        # LLM对话处理
        reply_text = await llm_service.chat(
            messages=chat_sessions[session_id],
            session_id=session_id
        )
        
        # 添加AI回复到历史（带滑动窗口裁剪）
        _append_history_and_trim(session_id, ChatMessage(role="assistant", content=reply_text))
        
        # TTS语音合成（可选）
        audio_data = None
        if request.generate_speech:
            audio_data = await tts_service.synthesize(reply_text)
            audio_data = base64.b64encode(audio_data).decode('utf-8') if audio_data else None
        
        return TextResponse(
            reply_text=reply_text,
            audio_data=audio_data,
            session_id=session_id
        )
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/avatar/init", response_model=AvatarInitResponse)
async def init_avatar(request: AvatarInitRequest):
    """
    初始化数字人会话（Simli P2P 路线）

    返回给前端：
      - session_id: 本次会话 ID（用于日志关联）
      - rtc_params:
          api_key       Simli API Key（前端用来调 generateSimliSessionToken + getIceServers）
          face_id       Simli Face ID
          session_token 由后端预先调 Simli 后端拿到的 token（前端也可以自己拿，但放后端更稳）
          max_session_length / max_idle_time
          handle_silence
      - avatar_params:
          provider: simli
          transport: p2p

    前端拿到 rtc_params 后，用 simli-client 的 SimliClient(token, videoEl, audioEl, iceServers, ..., "p2p") 建立 WebRTC 直连。

    ✅ 复用 session：avatar_id 字段如果传进来的是已有 session_id（且磁盘有历史），
    就直接复用，不再生成新 session_id。**前端"历史对话"切换对话时用这个机制**。
    """
    # ✅ 检查是否要复用旧 session
    reuse_sid: str | None = None
    if request.avatar_id and request.avatar_id.strip():
        candidate = request.avatar_id.strip()
        # 安全检查：文件存在 = 这个 session 之前有数据
        if _session_file_path(candidate).exists() or _session_meta_path(candidate).exists():
            reuse_sid = candidate
            logger.info(f"[Avatar] 复用 session_id={reuse_sid}")
    try:
        from services.config_service import config_service
        avatar_cfg = config_service.get_config("avatar")
    except Exception:
        avatar_cfg = {}

    provider = (avatar_cfg.get("provider") or "alibaba_wanxiang").strip().lower()
    if provider != "simli":
        raise HTTPException(
            status_code=400,
            detail=(
                f"当前 avatar provider={provider!r}，不是 simli。"
                "请到配置页切换数字人方案为 'Simli'"
            ),
        )

    simli_api_key = (avatar_cfg.get("simli_api_key") or "").strip()
    simli_face_id = (avatar_cfg.get("simli_face_id") or "").strip()

    if not simli_api_key:
        raise HTTPException(
            status_code=400,
            detail="simli_api_key 未配置，请到配置页填写 Simli API Key",
        )
    # 注意：Simli 的 API Key 不一定以 "simli_" 开头（已实测 key="1u53mficr0g..." 直接可用）
    # 不要在这里加任何前缀或后缀，原样传给 x-simli-api-key header
    if not simli_face_id:
        raise HTTPException(
            status_code=400,
            detail="simli_face_id 未配置，请到配置页填写 Simli Face ID",
        )

    # 调 Simli 后端 compose-session-token
    # 文档: https://docs.simli.com/api-reference/python
    try:
        # P2P 模式 payload（按官方文档）
        session_payload = {
            "faceId": simli_face_id,
            "apiVersion": "v2",
            "handleSilence": True,
            "maxSessionLength": 600,
            "maxIdleTime": 180,
            "audioInputFormat": "pcm16",
        }

        # 调 Simli REST
        # ✅ 防御性：禁用 keep-alive + 2 次重试，规避某些代理环境（如 Clash 7890）下
        # 第二个请求复用第一次连接被代理切断导致的失败
        import asyncio as _asyncio
        last_err: Exception | None = None
        for attempt in range(1, 3):
            try:
                async with httpx.AsyncClient(
                    timeout=15.0,
                    headers={"Connection": "close"},
                ) as client:
                    resp = await client.post(
                        "https://api.simli.ai/compose/token",
                        headers={
                            "Content-Type": "application/json",
                            "x-simli-api-key": simli_api_key,
                            "Connection": "close",
                        },
                        json=session_payload,
                    )
                break  # 成功，退出重试
            except (httpx.ConnectError, httpx.ReadError, httpx.RemoteProtocolError) as e:
                last_err = e
                logger.warning(
                    f"[Simli] compose-session-token 第 {attempt} 次失败（{type(e).__name__}），0.5s 后重试"
                )
                if attempt < 2:
                    await _asyncio.sleep(0.5)
        else:
            # 全部重试失败
            raise HTTPException(
                status_code=500,
                detail=f"Simli session token 创建失败（重试 2 次）: {last_err}",
            )
        if resp.status_code != 200:
            logger.error(
                f"[Simli] compose-session-token 失败: {resp.status_code} {resp.text}"
            )
            raise HTTPException(
                status_code=502,
                detail=f"Simli compose-session-token 失败: {resp.status_code} {resp.text}",
            )
        simli_session_token = resp.json().get("session_token") or resp.json().get("sessionToken")
        if not simli_session_token:
            raise HTTPException(
                status_code=502,
                detail=f"Simli 返回的 session_token 为空: {resp.text}",
            )
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Simli session token 创建失败")
        raise HTTPException(status_code=500, detail=f"Simli session token 创建失败: {e}")

    # ✅ 复用旧 session_id 或生成新的
    session_id = reuse_sid or uuid.uuid4().hex
    rtc_params = {
        # Simli P2P 真实凭证
        "api_key": simli_api_key,
        "face_id": simli_face_id,
        "session_token": simli_session_token,
        "transport": "p2p",
        "max_session_length": 600,
        "max_idle_time": 180,
        "handle_silence": True,
    }
    avatar_params = {
        "session_id": session_id,
        "provider": "simli",
        "transport": "p2p",
        "face_id": simli_face_id,
    }
    logger.info(
        f"[Simli] P2P session 创建: face_id={simli_face_id}, session_id={session_id}"
    )
    return AvatarInitResponse(
        session_id=session_id,
        rtc_params=rtc_params,
        avatar_params=avatar_params,
    )


@router.get("/avatar/params")
async def get_avatar_params():
    """
    获取数字人RTC参数（用于前端初始化）
    实际项目中需要结合后端API获取真实的RTC参数
    """
    return {
        "success": True,
        "message": "请调用 /api/avatar/init 接口获取完整的RTC参数"
    }


@router.get("/chat/history", response_model=ChatHistoryResponse)
async def get_chat_history(session_id: str):
    """获取聊天历史（从磁盘读完整历史，包含滑动窗口外的早期消息）"""
    messages = get_session_messages(session_id)
    return ChatHistoryResponse(
        messages=messages,
        session_id=session_id
    )


@router.delete("/chat/history/{session_id}")
async def clear_chat_history(session_id: str):
    """清除聊天历史（同时清内存 + 磁盘文件 + 元数据）"""
    if session_id in chat_sessions:
        del chat_sessions[session_id]
    try:
        _session_file_path(session_id).unlink(missing_ok=True)
    except Exception as e:
        logger.warning(f"[ChatHistory] 删除文件失败 {session_id}: {e}")
    # ✅ 同时删元数据
    try:
        _session_meta_path(session_id).unlink(missing_ok=True)
    except Exception as e:
        logger.warning(f"[ChatHistory] 删除元数据失败 {session_id}: {e}")
    return {"success": True, "message": f"Session {session_id} cleared"}


# ============================================================
# Session 元数据 + 语法纠错 持久化
# ============================================================

def _session_meta_path(session_id: str) -> _Path:
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in session_id)
    return _CHAT_HISTORY_DIR / f"{safe}.meta.json"


def _load_session_meta(session_id: str) -> dict:
    """读 session 元数据，文件不存在则返回默认空 meta。"""
    path = _session_meta_path(session_id)
    if not path.exists():
        return {
            "session_id": session_id,
            "title": "新对话",
            "scene": "daily",
            "created_at": _dt.utcnow().isoformat(),
            "updated_at": _dt.utcnow().isoformat(),
            "message_count": 0,
            "grammar_checks": [],
        }
    try:
        data = _json.loads(path.read_text(encoding="utf-8"))
        # 补全缺省字段（兼容旧数据）
        data.setdefault("grammar_checks", [])
        return data
    except Exception as e:
        logger.warning(f"[SessionMeta] 加载 {session_id} 失败: {e}")
        return {
            "session_id": session_id,
            "title": "新对话",
            "scene": "daily",
            "created_at": _dt.utcnow().isoformat(),
            "updated_at": _dt.utcnow().isoformat(),
            "message_count": 0,
            "grammar_checks": [],
        }


def _save_session_meta(meta: dict) -> None:
    """把 session meta 写到磁盘（线程安全）。"""
    with _write_lock:
        try:
            sid = meta["session_id"]
            meta["updated_at"] = _dt.utcnow().isoformat()
            _session_meta_path(sid).write_text(
                _json.dumps(meta, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except Exception as e:
            logger.warning(f"[SessionMeta] 写入失败: {e}")


def _update_session_meta_on_message(session_id: str, role: str, content: str, scene: str | None = None) -> None:
    """
    每次 append_history_and_trim 后调用：
    - 更新 message_count
    - 如果是首条 user 消息，自动生成 title
    - 记录 scene（如果是新 session）
    """
    meta = _load_session_meta(session_id)
    # 读历史拿真实 message count
    history = get_session_messages(session_id)
    meta["message_count"] = len(history)
    # 首条 user 消息 → 自动生成 title
    if not meta.get("title") or meta["title"] == "新对话":
        for m in history:
            if m.get("role") == "user" and m.get("content"):
                title = m["content"].strip()
                if len(title) > 30:
                    title = title[:30] + "..."
                meta["title"] = title
                break
    if scene:
        meta["scene"] = scene
    _save_session_meta(meta)


@router.get("/chat/sessions")
async def list_sessions():
    """
    列出所有 session 元数据，按 updated_at 倒序。
    用于前端"历史对话侧边栏"。
    """
    sessions: list[dict] = []
    for path in _CHAT_HISTORY_DIR.glob("*.meta.json"):
        try:
            data = _json.loads(path.read_text(encoding="utf-8"))
            sessions.append(data)
        except Exception:
            continue
    sessions.sort(key=lambda x: x.get("updated_at", ""), reverse=True)
    return {"sessions": sessions, "total": len(sessions)}


@router.patch("/chat/sessions/{session_id}")
async def update_session_title(session_id: str, payload: dict):
    """修改 session 标题（用户重命名）"""
    meta = _load_session_meta(session_id)
    if "title" in payload and payload["title"].strip():
        meta["title"] = payload["title"].strip()[:60]
    _save_session_meta(meta)
    return meta


@router.post("/chat/sessions/{session_id}/grammar-check")
async def save_grammar_check(session_id: str, payload: dict):
    """
    保存一条语法检查结果（前端在收到 LLM 输出的 <grammar>...</grammar> 后调）。
    payload = {
      "user_text": "I goes to school",
      "checks": [
        {"original": "I goes", "corrected": "I go", "explanation": "主语是 I 时动词用原形"}
      ]
    }
    """
    meta = _load_session_meta(session_id)
    entry = {
        "user_text": payload.get("user_text", ""),
        "checks": payload.get("checks", []),
        "created_at": _dt.utcnow().isoformat(),
    }
    if "grammar_checks" not in meta:
        meta["grammar_checks"] = []
    meta["grammar_checks"].append(entry)
    # 最多保留最近 50 条纠错（避免磁盘过大）
    meta["grammar_checks"] = meta["grammar_checks"][-50:]
    _save_session_meta(meta)
    return {"success": True, "count": len(entry["checks"])}


@router.post("/upload/audio")
async def upload_audio(
    file: UploadFile = File(...),
    session_id: Optional[str] = Form(None)
):
    """
    音频文件上传接口
    支持wav, mp3, m4a等格式
    """
    try:
        # 读取音频文件
        audio_data = await file.read()
        
        # 转换为base64
        audio_base64 = base64.b64encode(audio_data).decode('utf-8')
        
        # 调用语音对话接口
        voice_request = VoiceRequest(
            audio_data=audio_base64,
            session_id=session_id,
            format=file.filename.split('.')[-1] if '.' in file.filename else 'wav'
        )
        
        return await voice_chat(voice_request)
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ==================== 端到端流式对话管道 ====================
# 协议（与前端 useChatStream 一一对应）：
#
# 客户端 → 服务端（JSON）
#   {"type": "start", "session_id": "xxx", "language": "en"}
#   {"type": "audio", "data": "<base64 PCM int16 16kHz mono 帧>"}
#   {"type": "stop"}                 # 录音结束 → 触发 ASR 收尾 + LLM + TTS
#   {"type": "ping"}
#
# 服务端 → 客户端（JSON，统一 PipelineEvent 格式）
#   {"type": "ready"}
#   {"type": "asr_partial",       "text": "..."}
#   {"type": "asr_sentence_end",  "text": "..."}
#   {"type": "user_text_final",   "text": "...", "metrics": {...}}
#   {"type": "avatar_state",      "state": "listening|thinking|speaking"}
#   {"type": "llm_start"}
#   {"type": "llm_delta",         "text": "..."}
#   {"type": "llm_sentence",      "text": "...", "sentence_index": 0}
#   {"type": "llm_done"}
#   {"type": "tts_chunk",         "audio_data": "<base64 mp3>", "sentence_index": 0}
#   {"type": "tts_sentence",      "sentence_index": 0}
#   {"type": "tts_done"}
#   {"type": "pipeline_done"}
#   {"type": "error",             "message": "..."}
#   {"type": "pong"}

# 句子边界标点（中英混合 + 换行）
_SENTENCE_DELIMS = set(".!?。！？\n")


def _split_into_sentences(buffer: str):
    """
    把累积 buffer 切成完整句子 + 残余片段。
    返回 (sentences, remainder)。

    ⚠️ 当前 _run_pipeline_after_user_text 不再用此函数（旧版 TTS 流水线已废弃），
    保留以备未来需要。
    """
    sentences = []
    current = []
    for ch in buffer:
        current.append(ch)
        if ch in _SENTENCE_DELIMS:
            s = "".join(current).strip()
            if s:
                sentences.append(s)
            current = []
    remainder = "".join(current)
    return sentences, remainder


async def _send_event(websocket: WebSocket, event: PipelineEvent):
    """统一事件发送（保证不抛异常）"""
    try:
        await websocket.send_text(event.model_dump_json(exclude_none=True))
    except Exception as e:
        logger.warning(f"[ChatStream] send failed: {e}")


# ⚠️ 以下 TTS 流水线辅助函数已废弃：当前 _run_pipeline_after_user_text 不再
# 在后端跑 TTS，TTS 改由前端在收到 LLM 完整文本后主动调
# /api/config/tts/synthesize。保留这些函数仅作历史参考与回滚兜底。
async def _run_tts_for_sentence(
    sentence: str,
    sentence_index: int,
    websocket: WebSocket,
    tts_service: TTSService,
) -> bool:
    """
    把一句文本合成为 mp3（阻塞），整段合成完后通过 ws 发给前端（base64）。
    返回 True 表示成功。

    ⚠️ 仍保留以兼容旧调用；新版 _run_pipeline_after_user_text 改用流式 + 并发。
    """
    try:
        audio_bytes = await tts_service.synthesize(sentence)
        if not audio_bytes:
            await _send_event(websocket, PipelineEvent(
                type=PipelineEventType.ERROR,
                message=f"TTS 合成失败 (sentence #{sentence_index}): {sentence[:40]}",
            ))
            return False
        b64 = base64.b64encode(audio_bytes).decode("ascii")
        await _send_event(websocket, PipelineEvent(
            type=PipelineEventType.TTS_CHUNK,
            sentence_index=sentence_index,
            audio_data=b64,
            format="mp3",
        ))
        await _send_event(websocket, PipelineEvent(
            type=PipelineEventType.TTS_SENTENCE,
            sentence_index=sentence_index,
        ))
        return True
    except Exception as e:
        logger.exception("TTS error")
        await _send_event(websocket, PipelineEvent(
            type=PipelineEventType.ERROR,
            message=f"TTS 异常: {e}",
        ))
        return False


async def _tts_one_sentence_task(
    sentence: str,
    sentence_index: int,
    tts_service: TTSService,
    audio_out: dict,
) -> None:
    """
    后台任务：合成单句音频并把 base64 写入 audio_out[sentence_index]。
    不直接 await ws.send，由外层按 sentence_index 顺序推到前端，保证播放顺序。
    """
    try:
        audio_bytes = await tts_service.synthesize(sentence)
        if not audio_bytes:
            logger.warning(f"[TTS-Pipeline] sentence #{sentence_index} 合成空结果")
            return
        audio_out[sentence_index] = base64.b64encode(audio_bytes).decode("ascii")
        logger.info(
            f"[TTS-Pipeline] sentence #{sentence_index} ready "
            f"({len(audio_bytes)} bytes, {len(sentence)} chars)"
        )
    except Exception as e:
        logger.exception(f"[TTS-Pipeline] sentence #{sentence_index} 合成异常")



async def _run_pipeline_after_user_text(
    user_text: str,
    session_id: str,
    websocket: WebSocket,
    scene_id: str = "daily",
):
    """
    用户文本落定后，跑 LLM 流式 → 把完整文本通过 pipeline_done 推给前端。
    TTS 不再在后端跑，由前端收到完整文本后主动调 /api/config/tts/synthesize。
    """
    # ✅ 注入场景 system prompt（覆盖 config_service 的默认 prompt）
    from services.llm_service import build_system_prompt
    llm_service.reload_runtime_config()  # 先同步最新 key
    saved_prompt = llm_service.system_prompt
    llm_service.system_prompt = build_system_prompt(scene_id)

    try:
        # 1. 写入聊天历史（带滑动窗口裁剪）
        _append_history_and_trim(session_id, ChatMessage(role="user", content=user_text))

        # 2. 状态切到 thinking
        await _send_event(websocket, PipelineEvent(
            type=PipelineEventType.AVATAR_STATE, state="thinking",
        ))

        # 3. LLM 流式
        await _send_event(websocket, PipelineEvent(
            type=PipelineEventType.LLM_START, session_id=session_id,
        ))

        buffer = ""
        full_reply = []

        # 节流 LLM_DELTA 推送（≤ 20 fps）
        last_delta_push = 0.0
        delta_throttle_sec = 0.05
        pending_delta = ""

        async def _flush_pending_delta(force: bool = False):
            """节流推送 LLM token 增量（打字机效果）"""
            nonlocal pending_delta, last_delta_push
            if not pending_delta:
                return
            now = time.monotonic()
            if not force and (now - last_delta_push) < delta_throttle_sec:
                return
            try:
                await _send_event(websocket, PipelineEvent(
                    type=PipelineEventType.LLM_DELTA, text=pending_delta,
                ))
            except Exception:
                logger.warning("[Pipeline] flush LLM_DELTA 失败（ws 可能已关）")
            pending_delta = ""
            last_delta_push = now

        async for token in llm_service.chat_stream(
            messages=chat_sessions[session_id],
            session_id=session_id,
        ):
            if not token:
                continue
            full_reply.append(token)

            # 累积到 pending_delta，节流推送（打字机效果）
            pending_delta += token
            await _flush_pending_delta(force=False)
            await asyncio.sleep(0)

        # LLM 推完，强制 flush 残余 token
        await _flush_pending_delta(force=True)
        await _send_event(websocket, PipelineEvent(
            type=PipelineEventType.LLM_DONE,
        ))

        # 4. 写入 assistant 历史（带滑动窗口裁剪）
        reply_text = "".join(full_reply).strip()
        _append_history_and_trim(session_id, ChatMessage(role="assistant", content=reply_text))

        # 5. 整轮结束
        # ✅ 关键：把完整回复文本通过 pipeline_done 推给前端
        # 前端拿到完整文本后：1) 调 TTS 合成 2) 存到 IndexedDB 3) 立即喂数字人
        await _send_event(websocket, PipelineEvent(
            type=PipelineEventType.AVATAR_STATE, state="listening",
        ))
        await _send_event(websocket, PipelineEvent(
            type=PipelineEventType.PIPELINE_DONE,
            session_id=session_id,
            text=reply_text,
        ))
    finally:
        # ✅ 无论正常返回还是异常，都恢复 system_prompt（不影响其他 WS 连接）
        llm_service.system_prompt = saved_prompt


@router.websocket("/chat/stream")
async def chat_stream_ws(websocket: WebSocket):
    """
    端到端对话管道（批量 ASR 版本）。

    内部状态机：
      start  → 初始化（无 ASR 会话）
      audio  → 累积音频帧到 buffer
      stop   → 整段音频发给批量 ASR → LLM + TTS → 完成
    """
    await websocket.accept()
    session_id: Optional[str] = None
    ws_workspace_id: Optional[str] = None
    ws_api_key: Optional[str] = None
    ws_asr_model: str = "qwen-audio-3.1-asr-flash"
    language: str = "en"
    audio_buffer: List[bytes] = []  # 累积 PCM 帧
    loop = asyncio.get_running_loop()
    ws_closed = False
    # ✅ 严格一问一答：pipeline 跑起来后到 pipeline_done 之间，丢弃所有 audio / start，
    # 防止前端用户手势造成"上一轮没处理完又叠加下一轮音频"。
    pipeline_busy: bool = False
    # ✅ 场景 ID：每次 start 时从前端传来，拼到 LLM system_prompt 前
    ws_scene_id: str = "daily"

    async def emit(event: PipelineEvent):
        nonlocal ws_closed
        if ws_closed:
            return
        try:
            await websocket.send_text(event.model_dump_json(exclude_none=True))
        except Exception:
            ws_closed = True

    try:
        await emit(PipelineEvent(type=PipelineEventType.READY))

        while True:
            try:
                raw = await websocket.receive_text()
            except WebSocketDisconnect:
                logger.info(f"[ChatStream] client disconnected session={session_id}")
                break
            except Exception as e:
                logger.warning(f"[ChatStream] receive error: {e}")
                break

            try:
                msg = json.loads(raw)
            except Exception:
                await emit(PipelineEvent(
                    type=PipelineEventType.ERROR, message="invalid JSON",
                ))
                continue

            mtype = msg.get("type")

            if mtype == "ping":
                await emit(PipelineEvent(type=PipelineEventType.PONG))
                continue

            if mtype == "start":
                session_id = msg.get("session_id") or f"chat_{uuid.uuid4().hex[:12]}"
                language = msg.get("language", "en")
                audio_buffer.clear()
                # ✅ 同一连接内新一轮录音前，重置 busy 锁 + 清掉旧 audio_buffer
                pipeline_busy = False
                # ✅ 场景 ID（前端传来的场景选择，注入对应 system prompt）
                ws_scene_id = msg.get("scene_id", "daily")
                logger.info(f"[ChatStream] start, session={session_id}, scene={ws_scene_id}")
                # ---- 关键修复：从 config_service（前端设置页保存的）读 ASR 凭证，
                # 而不是 .env 里的占位 DASHSCOPE_API_KEY ----
                asr_cfg = _get_runtime_asr_config()
                ws_api_key = (asr_cfg.get("api_key") or "").strip() or None
                ws_workspace_id = (
                    msg.get("workspace_id")
                    or asr_cfg.get("workspace_id")
                    or os.getenv("DASHSCOPE_WORKSPACE_ID")
                    or None
                )
                ws_asr_model = (
                    msg.get("model")
                    or asr_cfg.get("model")
                    or "qwen-audio-3.1-asr-flash"
                )
                if ws_api_key:
                    # 让 dashscope 在子线程中也能拿到 key（双保险）
                    os.environ["DASHSCOPE_API_KEY"] = ws_api_key
                    try:
                        import dashscope as _ds
                        _ds.api_key = ws_api_key
                    except Exception:
                        pass
                logger.info(
                    f"[ChatStream] session start, "
                    f"key_set={bool(ws_api_key)}, "
                    f"ws_workspace_id={ws_workspace_id!r}, model={ws_asr_model}"
                )
                # ---- 关键修复：刷新 LLM/TTS 的运行时配置（前端设置页保存的），
                # 否则它们会一直用 .env 的占位 DASHSCOPE_API_KEY / OPENAI_API_KEY ----
                try:
                    llm_service.reload_runtime_config()
                except Exception as e:
                    logger.warning(f"[ChatStream] reload llm_runtime_config failed: {e}")
                try:
                    tts_service.reload_runtime_config()
                except Exception as e:
                    logger.warning(f"[ChatStream] reload tts_runtime_config failed: {e}")
                await emit(PipelineEvent(
                    type=PipelineEventType.AVATAR_STATE, state="listening",
                ))
                continue

            if mtype == "audio":
                data_b64 = msg.get("data")
                if not data_b64:
                    continue
                # ✅ pipeline 跑起来时拒绝新音频（防 race：用户在前一轮未完成时按下麦克风）
                if pipeline_busy:
                    logger.debug(
                        f"[ChatStream] audio dropped while pipeline_busy session={session_id}"
                    )
                    continue
                try:
                    raw_bytes = base64.b64decode(data_b64)
                    audio_buffer.append(raw_bytes)
                except Exception as e:
                    logger.warning(f"[ChatStream] audio decode err: {e}")
                continue

            if mtype == "stop":
                # ✅ stop 也受 pipeline_busy 保护：避免重复 stop 触发新一轮 ASR
                if pipeline_busy:
                    logger.warning(
                        f"[ChatStream] stop dropped while pipeline_busy session={session_id}"
                    )
                    continue
                pipeline_busy = True
                try:
                    # 合并所有音频帧
                    full_audio = b"".join(audio_buffer)
                    audio_buffer.clear()
                    logger.info(
                        f"[ChatStream] stop: collected {len(full_audio)} bytes of audio"
                    )
                    remove_stream_session(f"asr_{session_id}")

                    if not full_audio:
                        await emit(PipelineEvent(
                            type=PipelineEventType.ERROR,
                            message="未录制到音频",
                        ))
                        await emit(PipelineEvent(
                            type=PipelineEventType.PIPELINE_DONE,
                        ))
                        continue

                    # 调用批量 ASR（同步式，OpenAI 兼容接口）
                    # ---- 关键修复：把 config_service 里的 key 传给 ASRService 实例，
                    # 否则它会用 .env 里那个占位值，永远 401 / 不消耗额度 ----
                    from services.asr_service import ASRService as _ASRService
                    runtime_asr = _ASRService(api_key=ws_api_key)
                    if ws_asr_model:
                        runtime_asr.model = ws_asr_model
                    try:
                        user_text = await runtime_asr.recognize_batch(
                            audio_bytes=full_audio,
                            format="wav",  # 前端发的 PCM 可以当 wav
                            sample_rate=16000,
                            language=language,
                            model=ws_asr_model,
                            workspace_id=ws_workspace_id,
                        )
                    except Exception as e:
                        logger.exception("[ChatStream] batch ASR exception")
                        user_text = None

                    await emit(PipelineEvent(
                        type=PipelineEventType.USER_TEXT_FINAL,
                        session_id=session_id,
                        text=user_text or "",
                    ))

                    if not user_text:
                        await emit(PipelineEvent(
                            type=PipelineEventType.ERROR,
                            message="未识别到任何内容",
                        ))
                        await emit(PipelineEvent(
                            type=PipelineEventType.PIPELINE_DONE,
                        ))
                        continue

                    # 跑 LLM + TTS 管道
                    try:
                        await _run_pipeline_after_user_text(
                            user_text=user_text,
                            session_id=session_id,
                            websocket=websocket,
                            scene_id=ws_scene_id,
                        )
                    except Exception as e:
                        logger.exception("pipeline error")
                        await emit(PipelineEvent(
                            type=PipelineEventType.ERROR,
                            message=f"管道异常: {e}",
                        ))
                        await emit(PipelineEvent(
                            type=PipelineEventType.PIPELINE_DONE,
                        ))
                finally:
                    # ✅ 无论成功失败都释放锁，让前端可以发起下一轮
                    pipeline_busy = False
                continue

            await emit(PipelineEvent(
                type=PipelineEventType.ERROR,
                message=f"unknown message type: {mtype}",
            ))

    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.exception("ChatStream fatal")
        try:
            await emit(PipelineEvent(
                type=PipelineEventType.ERROR, message=str(e),
            ))
        except Exception:
            pass
