# coding=utf-8
"""
ASR 语音识别服务（统一封装）

支持两种识别模式：
- 批量识别：上传整段音频文件（OpenAI 兼容接口 + Base64）
- 流式识别：基于 WebSocket 的实时识别（dashscope.audio.asr.Recognition，对齐官方案例）

批量识别文档：
    https://docs.bailian.console.aliyun.com/zh/model-studio/non-realtime-speech-recognition-user-guide
"""
import io
import json
import logging
import os
import threading
import time
import asyncio
import base64
from typing import Optional, Dict, Any, List, Callable

import numpy as np
import soundfile as sf

from dashscope.audio.asr import (
    Recognition,
    RecognitionCallback,
    RecognitionResult,
)
from dashscope import audio as dashscope_audio
import aiohttp

from config import DASHSCOPE_API_KEY, ASR_MODEL, ASR_FORMAT, ASR_SAMPLE_RATE

logger = logging.getLogger(__name__)


# ========================= 批量识别 =========================

class ASRService:
    """批量 ASR 语音识别服务（整段音频文件识别）"""

    def __init__(self, api_key: Optional[str] = None):
        self.api_key = api_key or DASHSCOPE_API_KEY
        self.model = ASR_MODEL
        self.format = ASR_FORMAT
        self.sample_rate = ASR_SAMPLE_RATE

    def is_available(self) -> bool:
        """检查服务是否可用"""
        return bool(self.api_key)

    # ======================== 批量识别（OpenAI 兼容接口 + Base64）=====================

    async def recognize_batch(
        self,
        audio_bytes: bytes,
        format: str = "wav",
        sample_rate: int = 16000,
        language: str = "zh",
        model: str = "qwen-audio-3.1-asr-flash",
        workspace_id: Optional[str] = None,
        timeout: float = 30.0,
    ) -> Optional[str]:
        """
        通过 OpenAI 兼容接口进行批量 ASR 识别（同步调用）。

        适用于 qwen-audio-3.1-asr-flash 等支持 Base64 音频输入的模型。

        行为：
          1) 先走 OpenAI 兼容批量接口
          2) 失败（404 model not found / url error 等）→ 自动回退到
             流式模型 `qwen-audio-3.0-asr-flash-streaming` 一次性发送识别
        """
        try:
            # 1) 预处理音频（重采样为 16kHz 单声道）
            audio_data, sr = self._prepare_audio(audio_bytes, sample_rate)
            if audio_data is None:
                logger.error("音频预处理失败")
                return None

            # 2) 转 int16 PCM
            pcm16 = np.clip(audio_data * 32767, -32768, 32767).astype(np.int16)
            pcm_bytes = pcm16.tobytes()

            # 3) 构建 WAV 头 + 数据（确保 ASR 正确解析）
            wav_buffer = io.BytesIO()
            with sf.SoundFile(wav_buffer, mode='wb', samplerate=sr, channels=1, format='WAV', subtype='PCM_16') as wf:
                wf.write(pcm16)
            wav_bytes = wav_buffer.getvalue()

            # 4) Base64 编码 + Data URI
            audio_b64 = base64.b64encode(wav_bytes).decode("utf-8")
            data_uri = f"data:audio/wav;base64,{audio_b64}"

            # 5) 构建请求
            if workspace_id:
                base_url = f"https://{workspace_id}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"
            else:
                base_url = "https://dashscope.aliyuncs.com/compatible-mode/v1"

            headers = {
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            }

            payload = {
                "model": model,
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "input_audio",
                                "input_audio": {"data": data_uri}
                            }
                        ]
                    }
                ],
                "stream": False,
                "extra_body": {
                    "asr_options": {
                        "language": language,
                        "enable_itn": True,  # 自动标点
                    }
                }
            }

            logger.info(
                f"[BatchASR] POST {base_url}/chat/completions model={model} "
                f"audio_size={len(wav_bytes)} bytes ({len(pcm_bytes)} PCM bytes) sr={sr}"
            )

            # 6) 发送请求
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    f"{base_url}/chat/completions",
                    headers=headers,
                    json=payload,
                    timeout=aiohttp.ClientTimeout(total=timeout),
                ) as resp:
                    if resp.status != 200:
                        body = await resp.text()
                        logger.error(f"[BatchASR] HTTP {resp.status}: {body[:500]}")
                        # 400/404 等一般是 model 在该 workspace 不支持 OpenAI 兼容模式
                        # 自动回退到流式模型一次性识别
                        logger.warning(
                            f"[BatchASR] HTTP {resp.status} → 回退到流式模型 qwen-audio-3.0-asr-flash-streaming"
                        )
                        return await self._recognize_via_stream(
                            audio_data, sr, language,
                            "qwen-audio-3.0-asr-flash-streaming",
                            workspace_id,
                        )

                    result = await resp.json()

            # 7) 解析结果
            text = self._parse_openai_compatible_response(result)
            if text:
                logger.info(f"[BatchASR] recognized: {text!r}")
                return text

            # 解析出来为空也回退一次
            logger.warning("[BatchASR] 空结果，回退到流式模型")
            return await self._recognize_via_stream(
                audio_data, sr, language,
                "qwen-audio-3.0-asr-flash-streaming",
            )

        except asyncio.TimeoutError:
            logger.error("[BatchASR] 请求超时，回退到流式模型")
            try:
                audio_data2, sr2 = self._prepare_audio(audio_bytes, sample_rate)
                return await self._recognize_via_stream(
                    audio_data2, sr2, language,
                    "qwen-audio-3.0-asr-flash-streaming",
                )
            except Exception:
                return None
            try:
                audio_data2, sr2 = self._prepare_audio(audio_bytes, sample_rate)
                return await self._recognize_via_stream(
                    audio_data2, sr2, language,
                    "qwen-audio-3.0-asr-flash-streaming",
                    workspace_id,
                )
            except Exception:
                return None
        except Exception as e:
            logger.exception(f"[BatchASR] 识别异常: {e} → 回退到流式模型")
            try:
                audio_data2, sr2 = self._prepare_audio(audio_bytes, sample_rate)
                return await self._recognize_via_stream(
                    audio_data2, sr2, language,
                    "qwen-audio-3.0-asr-flash-streaming",
                    workspace_id,
                )
            except Exception:
                return None

    def _format_to_mime_type(self, fmt: str) -> str:
        """音频格式 → MIME type"""
        mapping = {
            "wav": "audio/wav",
            "mp3": "audio/mpeg",
            "m4a": "audio/mp4",
            "ogg": "audio/ogg",
            "pcm": "audio/pcm",
            "opus": "audio/opus",
        }
        return mapping.get(fmt.lower(), "audio/wav")

    def _parse_openai_compatible_response(self, result: Dict[str, Any]) -> Optional[str]:
        """
        解析 OpenAI 兼容接口返回结果。
        结构示例：
        {
          "output": {
            "output": {
              "sentence": {"text": "Hello World"}
            },
            "text": "Hello World"
          },
          "request_id": "..."
        }
        """
        try:
            # 优先取顶层 output.text
            output = result.get("output", {})
            text = output.get("text")
            if text:
                return text.strip()

            # 备选：output.output.sentence.text
            inner = output.get("output", {})
            if isinstance(inner, dict):
                sentence = inner.get("sentence", {})
                if isinstance(sentence, dict):
                    text = sentence.get("text")
                    if text:
                        return text.strip()

            # 备选：标准 OpenAI 格式
            choices = result.get("choices", [])
            if choices and isinstance(choices, list):
                msg = choices[0].get("message", {})
                text = msg.get("content", "")
                if text:
                    return text.strip()

            logger.warning(f"[BatchASR] 未找到识别文本，原始响应: {json.dumps(result, ensure_ascii=False)[:300]}")
            return None
        except Exception as e:
            logger.exception(f"[BatchASR] 解析响应异常: {e}")
            return None

    # ======================== 原有流式 / Transcription 保留（暂不删除）=====================

    async def recognize(
        self,
        audio_bytes: bytes,
        format: str = "wav",
        sample_rate: int = 16000,
        language: str = "en",
        model: Optional[str] = None,
    ) -> Optional[str]:
        """
        整段音频识别（同步式调用）

        优先走批量识别（OpenAI 兼容接口），不支持时回退流式。
        """
        try:
            # 1) 预处理音频
            audio_data, sr = self._prepare_audio(audio_bytes, sample_rate)

            if audio_data is None:
                logger.error("音频数据预处理失败")
                return None

            # 2) 选模型
            use_model = model or self.model

            # 3) qwen-audio-3.0 + streaming 走流式
            if "qwen-audio-3.0" in use_model and "streaming" in use_model:
                return await self._recognize_via_stream(audio_data, sr, language, use_model)

            # 4) 默认走批量识别（OpenAI 兼容接口，支持 Base64）
            return await self.recognize_batch(
                audio_bytes=audio_bytes,
                format=format,
                sample_rate=sr,
                language=language,
                model=use_model,
            )

        except Exception as e:
            logger.exception(f"ASR 识别异常: {e}")
            return self._fallback_recognize(audio_bytes)

    async def _recognize_via_stream(
        self,
        audio_data: np.ndarray,
        sample_rate: int,
        language: str,
        model: str,
        workspace_id: Optional[str] = None,
    ) -> Optional[str]:
        """
        把整段音频通过流式 ASR 走一遍（一次性发完所有 PCM 帧，再停止）
        """
        streaming_model = "qwen-audio-3.0-asr-flash-streaming"
        if "streaming" in model:
            streaming_model = model

        workspace_id_local = (workspace_id or "").strip() or None

        # 转 int16 PCM 字节流
        pcm16 = np.clip(audio_data * 32767, -32768, 32767).astype(np.int16)
        pcm_bytes = pcm16.tobytes()

        # 每帧 100ms
        frame_samples = int(sample_rate * 0.1) * 2  # int16 = 2 bytes
        loop = asyncio.get_running_loop()
        finished = asyncio.Event()
        collected_text: list[str] = []

        def on_sentence_end(text: str):
            if text:
                collected_text.append(text)

        def on_complete():
            loop.call_soon_threadsafe(finished.set)

        def on_error(err: str):
            logger.error(f"[stream-recognize] error: {err}")
            loop.call_soon_threadsafe(finished.set)

        # 关键：在主进程里设置 dashscope.api_key（子线程里 dashscope 也读这里）
        try:
            import dashscope as _ds
            _ds.api_key = self.api_key
            import os as _os
            _os.environ["DASHSCOPE_API_KEY"] = self.api_key
            if workspace_id_local:
                _os.environ["DASHSCOPE_BASE_WEBSOCKET_API_URL"] = (
                    f"wss://{workspace_id_local}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference"
                )
        except Exception:
            pass

        session = StreamASRSession(
            on_sentence_end=on_sentence_end,
            on_complete=on_complete,
            on_error=on_error,
            model=streaming_model,
            format="pcm",
            sample_rate=sample_rate,
            language=language,
            workspace_id=workspace_id_local,
            api_key=self.api_key,  # ⚠️ 关键：必须把 self.api_key 传下去，否则它会用 .env 的占位符
        )

        try:
            session.start()
            # 等 open
            for _ in range(50):
                await asyncio.sleep(0.1)
                if session._is_open:
                    break

            # 切片推送
            for i in range(0, len(pcm_bytes), frame_samples):
                chunk = pcm_bytes[i:i + frame_samples]
                try:
                    session.send_audio_frame(chunk)
                except Exception as e:
                    logger.error(f"send frame failed: {e}")
                    break
                await asyncio.sleep(0.005)  # 5ms 让 dashscope 处理

            # 等识别完成 / 默认 30s 超时（流式 ASR 模型识别一段音频需要时间）
            try:
                await asyncio.wait_for(finished.wait(), timeout=30)
            except asyncio.TimeoutError:
                logger.warning("stream-recognize timeout (30s), force stop")

            session.stop()
            text = session.get_full_text() or " ".join(collected_text)
            return text.strip() or None
        except Exception as e:
            logger.exception(f"_recognize_via_stream failed: {e}")
            try:
                session.stop()
            except Exception:
                pass
            return None

    async def _recognize_via_transcription(
        self,
        audio_bytes: bytes,
        format: str,
        sample_rate: int,
        language: str,
        model: str,
    ) -> Optional[str]:
        """
        通过 Transcription 接口识别（适用于 paraformer-* 系列）
        注意：需要上传到 OSS，给出 URL。这里我们直接写出 wav 并使用本地路径。
        """
        import tempfile

        tmp_fd, tmp_path = tempfile.mkstemp(suffix=f".{format}")
        os.close(tmp_fd)
        try:
            with open(tmp_path, "wb") as f:
                f.write(audio_bytes)

            # Transcription 需要 URL，没有 OSS 时退化为流式（万能方案）
            logger.warning(
                f"Transcription 仅支持远端 URL，本地文件 {tmp_path} 无法直接识别，自动改走流式模型"
            )
            return await self._recognize_via_stream(
                self._bytes_to_float32_array(audio_bytes, sample_rate),
                sample_rate,
                language,
                model,
            )
        finally:
            if os.path.exists(tmp_path):
                try:
                    os.remove(tmp_path)
                except Exception:
                    pass

    def _bytes_to_float32_array(self, audio_bytes: bytes, target_sr: int) -> np.ndarray:
        audio_data, sr = self._prepare_audio(audio_bytes, target_sr)
        if isinstance(audio_data, np.ndarray):
            return audio_data.astype(np.float32)
        return np.zeros(1, dtype=np.float32)

    def _prepare_audio(self, audio_bytes: bytes, target_sample_rate: int = 16000):
        """
        解析音频 → numpy 单声道数组
        如果采样率不一致则线性插值重采样。

        支持两种输入格式：
        1. 带 WAV/OGG 等容器头的音频（soundfile 解析）
        2. 原始 PCM int16 数据（无容器头，直接按 target_sample_rate 解析）
        """
        try:
            audio_data, sr = sf.read(io.BytesIO(audio_bytes))

            # 立体声 → 单声道
            if audio_data.ndim > 1:
                audio_data = np.mean(audio_data, axis=1)

            if sr != target_sample_rate:
                audio_data = self._resample(audio_data, sr, target_sample_rate)
                sr = target_sample_rate

            return audio_data.astype(np.float32), sr
        except Exception as e:
            # soundfile 解析失败，可能是原始 PCM（无 WAV 头）
            logger.warning(f"音频解析失败，尝试按原始 PCM 处理: {e}")
            return self._parse_raw_pcm(audio_bytes, target_sample_rate)

    def _parse_raw_pcm(self, audio_bytes: bytes, sample_rate: int = 16000) -> tuple:
        """
        将原始 PCM int16 数据（无 WAV 头）解析为 float32 数组。
        前端麦克风采集的 16kHz mono Int16 PCM 数据属于这种格式。
        """
        try:
            # 假设是 int16 (2 bytes per sample)
            num_samples = len(audio_bytes) // 2
            int16_data = np.frombuffer(audio_bytes[:num_samples * 2], dtype=np.int16)
            # int16 → float32 [-1, 1]
            float_data = int16_data.astype(np.float32) / 32768.0
            return float_data, sample_rate
        except Exception as e:
            logger.warning(f"原始 PCM 解析失败: {e}")
            return audio_bytes, sample_rate

    def _resample(self, audio: np.ndarray, orig_sr: int, target_sr: int) -> np.ndarray:
        """线性插值重采样"""
        try:
            duration = len(audio) / orig_sr
            target_length = int(duration * target_sr)
            indices = np.linspace(0, len(audio) - 1, target_length)
            return np.interp(indices, np.arange(len(audio)), audio).astype(audio.dtype)
        except Exception:
            return audio

    def _fallback_recognize(self, audio_bytes: bytes) -> Optional[str]:
        """备用识别占位（前端会用浏览器 WebSpeech API 兜底）"""
        logger.warning("ASR API 调用失败，返回 None（前端应兜底）")
        return None


# ========================= 流式识别 =========================

class StreamASRSession:
    """
    单次流式 ASR 会话。

    生命周期：
      1) 创建会话（自动调用 Recognition.start，建立 WebSocket）
      2) 持续 send_audio_frame(...) 推送 PCM int16 帧
      3) 回调里通过 on_text / on_sentence_end 拿到识别文本
      4) stop() 结束识别

    内部依赖 DashScope 的 Recognition + RecognitionCallback
    （对齐官方 Quick Start 实时识别文档结构）
    """

    SUPPORTED_FORMATS = {"pcm", "wav", "opus", "speex", "aac", "amr"}
    SUPPORTED_SAMPLE_RATES = {8000, 16000}

    def __init__(
        self,
        on_partial: Optional[Callable[[str], None]] = None,
        on_sentence_end: Optional[Callable[[str], None]] = None,
        on_complete: Optional[Callable[[], None]] = None,
        on_error: Optional[Callable[[str], None]] = None,
        on_open: Optional[Callable[[], None]] = None,
        on_close: Optional[Callable[[], None]] = None,
        api_key: Optional[str] = None,
        model: str = "qwen-audio-3.0-asr-flash-streaming",
        format: str = "pcm",
        sample_rate: int = 16000,
        language: str = "en",
        workspace_id: Optional[str] = None,
    ):
        self.api_key = api_key or DASHSCOPE_API_KEY
        self.model = model
        self.format = format if format in self.SUPPORTED_FORMATS else "pcm"
        self.sample_rate = sample_rate if sample_rate in self.SUPPORTED_SAMPLE_RATES else 16000
        self.language = language

        self._sentences: List[str] = []
        self._partial = ""
        self._request_id: Optional[str] = None
        self._first_delay_ms: Optional[int] = None
        self._last_delay_ms: Optional[int] = None
        self._started_at: Optional[float] = None
        self._is_open = False
        self._is_complete = False
        self._error_message: Optional[str] = None
        self._lock = threading.Lock()

        # ---- 校验工作空间 ID（官方要求 cn-beijing 等多地域需配置 ws URL）----
        base_ws_url = "wss://dashscope.aliyuncs.com/api-ws/v1/inference"
        if workspace_id:
            base_ws_url = f"wss://{workspace_id}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference"
            os.environ["DASHSCOPE_BASE_WEBSOCKET_API_URL"] = base_ws_url

        # ---- 构建 DashScope 回调封装 ----
        outer_self = self

        class _Callback(RecognitionCallback):
            def on_open(_self) -> None:
                outer_self._on_open()

            def on_close(_self) -> None:
                outer_self._on_close()

            def on_complete(_self) -> None:
                outer_self._on_complete()

            def on_error(_self, message) -> None:
                outer_self._on_error(message)

            def on_event(_self, result: RecognitionResult) -> None:
                outer_self._on_event(result)

        # ---- 构造 Recognition 时显式传入 workspace（不靠环境变量）----
        # 官方签名：Recognition(model, callback, format, sample_rate, workspace=None, **kwargs)
        self._recognition: Optional[Recognition] = Recognition(
            self.model,
            _Callback(),
            self.format,
            self.sample_rate,
            workspace=workspace_id,
        )

        # ---- 把回调暴露到外层 ----
        self._cb_partial = on_partial
        self._cb_sentence_end = on_sentence_end
        self._cb_complete = on_complete
        self._cb_error = on_error
        self._cb_open = on_open
        self._cb_close = on_close

    # ---------------- DashScope 回调实现 ----------------

    def _on_open(self):
        with self._lock:
            self._is_open = True
            self._started_at = time.time()
        logger.info("[StreamASR] WebSocket open")
        if self._cb_open:
            try:
                self._cb_open()
            except Exception:
                logger.exception("on_open callback failed")

    def _on_close(self):
        with self._lock:
            self._is_open = False
        logger.info("[StreamASR] WebSocket close")
        if self._cb_close:
            try:
                self._cb_close()
            except Exception:
                logger.exception("on_close callback failed")

    def _on_complete(self):
        with self._lock:
            self._is_complete = True
        logger.info("[StreamASR] recognition completed")
        if self._cb_complete:
            try:
                self._cb_complete()
            except Exception:
                logger.exception("on_complete callback failed")

    def _on_error(self, message):
        # dashscope 1.20.x 的 RecognitionResult 顶层有 status_code / message 属性
        # 不要再访问 payload（不存在）
        msg = None
        try:
            status = getattr(message, "status_code", None)
            text = getattr(message, "message", None)
            code = getattr(message, "code", None)
            parts = []
            if status is not None:
                parts.append(f"status={status}")
            if code:
                parts.append(f"code={code}")
            if text:
                parts.append(f"message={text}")
            msg = " | ".join(parts) if parts else None
            # 兼容旧版 payload 字段
            if not msg:
                payload = getattr(message, "payload", None)
                if payload and isinstance(payload, dict):
                    msg = payload.get("error_message") or payload.get("message") or str(payload)
        except Exception as e:
            msg = f"<error extraction failed: {e}>"
        if not msg:
            msg = repr(message)
        rid = getattr(message, "request_id", "") or ""
        with self._lock:
            self._error_message = msg
        logger.error(f"[StreamASR] error rid={rid} {msg}")
        if self._cb_error:
            try:
                self._cb_error(msg)
            except Exception:
                logger.exception("on_error callback failed")

    def _on_event(self, result: RecognitionResult):
        try:
            sentence = result.get_sentence()
            text = sentence.get("text", "") if isinstance(sentence, dict) else ""

            with self._lock:
                # 延迟统计
                try:
                    self._request_id = result.get_request_id()
                except Exception:
                    pass
                try:
                    if self._first_delay_ms is None:
                        self._first_delay_ms = result.get_first_package_delay()
                    self._last_delay_ms = result.get_last_package_delay()
                except Exception:
                    pass

                if RecognitionResult.is_sentence_end(sentence):
                    self._sentences.append(text)
                    self._partial = ""
                else:
                    self._partial = text

            if RecognitionResult.is_sentence_end(sentence) and text:
                logger.info(f"[StreamASR] sentence_end: {text}")
                if self._cb_sentence_end:
                    try:
                        self._cb_sentence_end(text)
                    except Exception:
                        logger.exception("on_sentence_end callback failed")
            elif text:
                if self._cb_partial:
                    try:
                        self._cb_partial(text)
                    except Exception:
                        logger.exception("on_partial callback failed")
        except Exception:
            logger.exception("_on_event handler error")

    # ---------------- 公共 API ----------------

    def start(self):
        """启动识别（建立 WebSocket）"""
        if not self.api_key:
            raise RuntimeError("DASHSCOPE_API_KEY 未配置，无法启动流式 ASR")

        # 关键：必须同时设置环境变量 + dashscope 模块属性，
        # 因为子线程中 dashscope 通过 dashscope.api_key 模块属性读取 key
        # 而环境变量只在 dashscope 初始化时读一次
        os.environ["DASHSCOPE_API_KEY"] = self.api_key
        try:
            import dashscope as _ds
            _ds.api_key = self.api_key
            logger.info(
                f"[StreamASR] set dashscope.api_key={self.api_key[:10]}... "
                f"(verify={(_ds.api_key or '')[:10]}...)"
            )
        except Exception as e:
            logger.warning(f"[StreamASR] set dashscope.api_key 失败: {e}")

        logger.info(
            f"[StreamASR] start model={self.model} format={self.format} sr={self.sample_rate} lang={self.language}"
        )
        self._recognition.start()

    def send_audio_frame(self, pcm_bytes: bytes):
        """
        推送一帧 PCM int16 字节流（16kHz / 单声道）。
        WebSocket 客户端通常每 100~200ms 推送一次。
        """
        if not self._is_open:
            raise RuntimeError("流式 ASR 尚未打开，无法发送音频帧")

        # DashScope 期望一个可读的字节流；为安全起见转 bytes
        if isinstance(pcm_bytes, (bytes, bytearray)):
            self._recognition.send_audio_frame(bytes(pcm_bytes))
        else:
            raise TypeError("send_audio_frame 仅接受 bytes")

    def stop(self, wait_complete: bool = True, timeout: float = 3.0):
        """停止识别

        wait_complete=True 时会阻塞等待 dashscope 的 on_complete 回调回来，
        以确保 _sentences / _partial 都被填满（避免最后一波识别结果被丢）。
        """
        try:
            self._recognition.stop()
        except Exception:
            # 重复 stop 会抛 "Speech recognition has stopped."，静默
            pass

        if wait_complete:
            # 等回调（partial / sentence_end / complete）落地
            deadline = time.time() + timeout
            while time.time() < deadline:
                with self._lock:
                    if self._is_complete or self._error_message:
                        break
                time.sleep(0.05)

    # ---------------- 状态查询 ----------------

    def get_full_text(self) -> str:
        """拼接所有已完成的句子 + 最后的 partial（兜底）

        如果 stop 时 DashScope 还来不及发 sentence_end，最后一段 partial 也会带上
        """
        with self._lock:
            parts = [s for s in self._sentences if s]
            if self._partial:
                parts.append(self._partial)
            return " ".join(parts).strip()

    def get_partial_text(self) -> str:
        with self._lock:
            return self._partial

    def get_metrics(self) -> Dict[str, Any]:
        with self._lock:
            return {
                "request_id": self._request_id,
                "first_package_delay_ms": self._first_delay_ms,
                "last_package_delay_ms": self._last_delay_ms,
                "is_open": self._is_open,
                "is_complete": self._is_complete,
                "error": self._error_message,
                "sentence_count": len(self._sentences),
                "duration_ms": (time.time() - self._started_at) * 1000 if self._started_at else 0,
            }


# ========================= 工厂函数 =========================

_stream_sessions: Dict[str, StreamASRSession] = {}
_stream_lock = threading.Lock()


def create_stream_session(session_id: str, **kwargs) -> StreamASRSession:
    """创建并登记一个流式会话"""
    with _stream_lock:
        if session_id in _stream_sessions:
            logger.warning(f"StreamASRSession {session_id} 已存在，将覆盖")
            try:
                _stream_sessions[session_id].stop()
            except Exception:
                pass
        sess = StreamASRSession(**kwargs)
        _stream_sessions[session_id] = sess
        return sess


def get_stream_session(session_id: str) -> Optional[StreamASRSession]:
    with _stream_lock:
        return _stream_sessions.get(session_id)


def remove_stream_session(session_id: str) -> Optional[StreamASRSession]:
    with _stream_lock:
        return _stream_sessions.pop(session_id, None)


# 全局批量识别实例
asr_service = ASRService()
