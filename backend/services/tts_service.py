# coding=utf-8
"""
TTS 语音合成服务（对齐阿里云官方 CosyVoice / Qwen-Audio-TTS Python SDK v2）

参考文档：https://docs.bailian.console.aliyun.com/zh/model-studio/cosyvoice-python-sdk

核心接口：
  - dashscope.audio.tts_v2.SpeechSynthesizer
  - call(text)           → 阻塞等待完整音频 bytes（内部通过回调收集）
  - streaming_call(text) → 分片提交文本（配合 streaming_complete / streaming_cancel）
  - streaming_complete()  → 通知服务端文本发送完毕，阻塞等待剩余音频返回

默认使用 qwen-audio-3.0-tts-flash + longanhuan_v3.6（已实机验证）。
"""
import base64
import io
import json
import logging
import os
import queue
import threading
import time
from typing import AsyncIterator, List, Optional

import dashscope
from dashscope.audio.tts_v2 import AudioFormat, ResultCallback, SpeechSynthesizer

from config import DASHSCOPE_API_KEY, TTS_MODEL, TTS_FORMAT, TTS_SAMPLE_RATE, DEFAULT_TTS_VOICE

logger = logging.getLogger(__name__)


# ========================= 同步回调（用于非流式）=========================

class _SyncCallback(ResultCallback):
    """
    同步回调：wait() 阻塞直到 on_complete / on_error，然后返回合并后的完整音频 bytes。
    """

    def __init__(self):
        self._chunks: List[bytes] = []
        self._complete = threading.Event()
        self._error: Optional[str] = None
        self._request_id: Optional[str] = None

    def on_open(self) -> None:
        logger.debug("[TTS-SyncCallback] open")

    def on_error(self, message: str) -> None:
        try:
            d = json.loads(message)
            self._error = (
                f"{d.get('header', {}).get('error_code', '?')}: "
                f"{d.get('header', {}).get('error_message', message)}"
            )
        except Exception:
            self._error = str(message)
        logger.error(f"[TTS-SyncCallback] error: {self._error}")
        self._complete.set()

    def on_complete(self) -> None:
        logger.debug("[TTS-SyncCallback] complete")
        self._complete.set()

    def on_close(self) -> None:
        logger.debug("[TTS-SyncCallback] close")

    def on_event(self, message: str) -> None:
        try:
            d = json.loads(message)
            header = d.get("header", {})
            self._request_id = header.get("task_id")
            et = d.get("payload", {}).get("output", {}).get("type", "")
            if et:
                logger.debug(f"[TTS-SyncCallback] event: {et}")
        except Exception:
            pass

    def on_data(self, data: bytes) -> None:
        self._chunks.append(data)

    def wait(self, timeout: float = 30.0) -> bytes:
        """等待合成完成并返回合并后的音频 bytes"""
        ok = self._complete.wait(timeout=timeout)
        if not ok:
            logger.warning("[TTS-SyncCallback] wait timeout after %.1fs", timeout)
        if self._error and not self._chunks:
            raise RuntimeError(f"TTS 合成错误: {self._error}")
        return b"".join(self._chunks)

    def get_error(self) -> Optional[str]:
        """返回最后一次回调收集到的错误信息（无错误返回 None）"""
        return self._error


# ========================= 流式回调（用于流式合成）=========================

class _StreamCallback(ResultCallback):
    """
    流式回调：通过 queue 线程安全地传递音频块，供 async 生成器消费。
    """

    def __init__(self, q: queue.Queue, done: threading.Event):
        self._q = q
        self._done = done
        self._error: Optional[str] = None

    def on_open(self) -> None:
        logger.debug("[TTS-StreamCallback] open")

    def on_error(self, message: str) -> None:
        try:
            d = json.loads(message)
            self._error = (
                f"{d.get('header', {}).get('error_code', '?')}: "
                f"{d.get('header', {}).get('error_message', message)}"
            )
        except Exception:
            self._error = str(message)
        logger.error(f"[TTS-StreamCallback] error: {self._error}")
        self._done.set()

    def on_complete(self) -> None:
        logger.debug("[TTS-StreamCallback] complete")
        self._done.set()

    def on_close(self) -> None:
        logger.debug("[TTS-StreamCallback] close")

    def on_event(self, message: str) -> None:
        try:
            d = json.loads(message)
            et = d.get("payload", {}).get("output", {}).get("type", "")
            if et:
                logger.debug(f"[TTS-StreamCallback] event: {et}")
        except Exception:
            pass

    def on_data(self, data: bytes) -> None:
        self._q.put(data)


# ========================= TTS 服务 =========================

class TTSService:
    """语音合成服务（基于 dashscope.audio.tts_v2.SpeechSynthesizer）"""

    # 已验证可用的模型 + 音色组合
    DEFAULT_MODEL = "qwen-audio-3.0-tts-flash"
    DEFAULT_VOICE = "longanhuan_v3.6"

    def __init__(self, api_key: Optional[str] = None):
        self.api_key = api_key or DASHSCOPE_API_KEY
        self.model = TTS_MODEL or self.DEFAULT_MODEL
        self.format = TTS_FORMAT or "mp3"
        self.sample_rate = TTS_SAMPLE_RATE or 22050
        self.voice = DEFAULT_TTS_VOICE
        # workspace_id 来自 config_service（如有）
        self.workspace_id: Optional[str] = None

        # 启动时立刻同步一次运行时配置（与 ASR / LLM 行为对齐）
        self.reload_runtime_config()

    def is_available(self) -> bool:
        return bool(self.api_key)

    def reload_runtime_config(self) -> None:
        """
        从 config_service 重新加载运行时配置（api_key / model / voice / format /
        sample_rate / workspace_id）。这样前端设置页保存的 dashscope key 才会
        真正被使用，而不是只读 .env 里的占位值（与 ASR / LLM 行为对齐）。
        """
        try:
            from services.config_service import config_service
            cfg = config_service.get_config("tts") or {}
        except Exception as e:
            logger.warning(f"[TTS] 读 config_service['tts'] 失败，回退到 .env: {e}")
            cfg = {}

        if cfg.get("api_key"):
            self.api_key = cfg["api_key"].strip() or self.api_key
        if cfg.get("model"):
            self.model = cfg["model"].strip() or self.model
        if cfg.get("voice"):
            self.voice = cfg["voice"].strip() or self.voice
        if cfg.get("format"):
            self.format = cfg["format"].strip() or self.format
        try:
            if cfg.get("sample_rate") is not None:
                self.sample_rate = int(cfg["sample_rate"])
        except (TypeError, ValueError):
            pass
        if cfg.get("workspace_id"):
            self.workspace_id = cfg["workspace_id"].strip() or self.workspace_id

        logger.info(
            f"[TTS] reload_runtime_config: model={self.model} voice={self.voice} "
            f"format={self.format} sr={self.sample_rate} workspace_id={self.workspace_id!r} "
            f"key_set={bool(self.api_key)}"
        )

    def _ensure_dashscope_config(self, api_key: Optional[str] = None) -> None:
        """
        配置 dashscope 全局参数。

        关键：dashscope 的 WebSocket 内部在子线程中调用
        dashscope.api_key 模块属性读取 key（而非每次从 env 读）。
        因此必须显式设置 dashscope.api_key。
        """
        key = api_key or self.api_key
        os.environ["DASHSCOPE_API_KEY"] = key
        try:
            dashscope.api_key = key
        except Exception:
            pass

    def _map_audio_format(self, fmt: str, sr: int) -> AudioFormat:
        """将 (format, sample_rate) 映射为 AudioFormat 枚举"""
        key = (fmt.lower(), sr)
        table = {
            ("mp3", 16000): AudioFormat.MP3_16000HZ_MONO_128KBPS,
            ("mp3", 22050): AudioFormat.MP3_22050HZ_MONO_256KBPS,
            ("mp3", 24000): AudioFormat.MP3_24000HZ_MONO_256KBPS,
            ("mp3", 44100): AudioFormat.MP3_44100HZ_MONO_256KBPS,
            ("mp3", 48000): AudioFormat.MP3_48000HZ_MONO_256KBPS,
            ("mp3", 8000): AudioFormat.MP3_8000HZ_MONO_128KBPS,
            ("pcm", 16000): AudioFormat.PCM_16000HZ_MONO_16BIT,
            ("pcm", 22050): AudioFormat.PCM_22050HZ_MONO_16BIT,
            ("pcm", 24000): AudioFormat.PCM_24000HZ_MONO_16BIT,
            ("pcm", 44100): AudioFormat.PCM_44100HZ_MONO_16BIT,
            ("pcm", 48000): AudioFormat.PCM_48000HZ_MONO_16BIT,
            ("pcm", 8000): AudioFormat.PCM_8000HZ_MONO_16BIT,
            ("wav", 16000): AudioFormat.WAV_16000HZ_MONO_16BIT,
            ("wav", 22050): AudioFormat.WAV_22050HZ_MONO_16BIT,
            ("wav", 24000): AudioFormat.WAV_24000HZ_MONO_16BIT,
            ("wav", 44100): AudioFormat.WAV_44100HZ_MONO_16BIT,
            ("wav", 48000): AudioFormat.WAV_48000HZ_MONO_16BIT,
            ("wav", 8000): AudioFormat.WAV_8000HZ_MONO_16BIT,
        }
        return table.get(key, AudioFormat.MP3_22050HZ_MONO_256KBPS)

    async def synthesize(
        self,
        text: str,
        voice: Optional[str] = None,
        model: Optional[str] = None,
        format: Optional[str] = None,
        sample_rate: Optional[int] = None,
        speech_rate: float = 1.0,
        pitch_rate: float = 1.0,
    ) -> Optional[bytes]:
        """
        合成语音（非流式，阻塞等待完整音频 bytes）

        Args:
            text: 待合成的文本（不超过 20000 字符）
            voice: 音色名称，默认 longanhuan_v3.6
            model: 模型名称，默认 qwen-audio-3.0-tts-flash
            format: 输出格式 mp3 / pcm / wav
            sample_rate: 采样率
            speech_rate: 语速（0.5 ~ 2.0）
            pitch_rate: 音调（0.5 ~ 2.0）

        Returns:
            音频数据 bytes，失败返回 None
        """
        if not self.is_available():
            logger.error("TTS 未配置 API Key")
            return None

        try:
            target_voice = voice or self.voice
            target_model = model or self.model
            target_format = format or self.format
            target_sr = sample_rate or self.sample_rate

            self._ensure_dashscope_config()
            audio_format = self._map_audio_format(target_format, target_sr)

            audio_data = self._do_synthesize_with_voice(
                text=text,
                voice=target_voice,
                model=target_model,
                audio_format=audio_format,
                speech_rate=speech_rate,
                pitch_rate=pitch_rate,
                timeout=30.0,
            )
            if audio_data is None:
                # voice 可能非法（如 cosyvoice 不认 long_en_happy → 411），
                # 回退到默认 voice 重试一次，让数字人至少能说话。
                fallback_voice = (
                    self.DEFAULT_VOICE if target_voice != self.DEFAULT_VOICE else "longxiaochun_v2"
                )
                logger.warning(
                    f"[TTS] 首次合成失败（voice={target_voice}），回退到 {fallback_voice} 重试"
                )
                audio_data = self._do_synthesize_with_voice(
                    text=text,
                    voice=fallback_voice,
                    model=target_model,
                    audio_format=audio_format,
                    speech_rate=speech_rate,
                    pitch_rate=pitch_rate,
                    timeout=30.0,
                )
                if audio_data is None:
                    logger.error(f"[TTS] 回退合成仍失败（voice={fallback_voice}）")
                    return None
                logger.info(f"[TTS] 回退合成成功: {len(audio_data)} bytes (voice={fallback_voice})")
                return audio_data

            logger.info(f"[TTS] 合成成功: {len(audio_data)} bytes")
            return audio_data

        except Exception as e:
            logger.exception(f"[TTS] 合成异常: {e}")
            return None

    def _do_synthesize_with_voice(
        self,
        text: str,
        voice: str,
        model: str,
        audio_format: str,
        speech_rate: float,
        pitch_rate: float,
        timeout: float,
    ) -> Optional[bytes]:
        """
        用指定 voice 合成一次；失败返回 None（不抛异常），让调用方决定是否 fallback。
        """
        callback = _SyncCallback()
        synthesizer = SpeechSynthesizer(
            model=model,
            voice=voice,
            format=audio_format,
            speech_rate=speech_rate,
            pitch_rate=pitch_rate,
            callback=callback,
        )
        logger.info(
            f"[TTS] synthesizing: model={model}, voice={voice}, "
            f"format={audio_format}, text_len={len(text)}"
        )
        try:
            synthesizer.call(text)
        except Exception as e:
            logger.warning(f"[TTS] synthesize.call 抛异常: {e}")
            return None
        try:
            return callback.wait(timeout=timeout)
        except RuntimeError as e:
            # wait() 在错误时抛 RuntimeError（callback 收到 on_error 且无音频数据）
            logger.warning(f"[TTS] synthesize.wait 抛异常: {e}")
            return None

    async def synthesize_stream(
        self,
        text_chunks: List[str],
        voice: Optional[str] = None,
        model: Optional[str] = None,
        format: Optional[str] = None,
        sample_rate: Optional[int] = None,
        speech_rate: float = 1.0,
        pitch_rate: float = 1.0,
    ) -> AsyncIterator[bytes]:
        """
        流式合成语音（分片提交文本，实时 yield 音频块）

        用法：
            async for chunk in tts.synthesize_stream(['Hello', ' world']):
                print(len(chunk))

        Args:
            text_chunks: 文本片段列表（单次不超过 20000 字符，累计不超过 20 万字符）
            其他参数同 synthesize

        Yields:
            bytes: 音频数据块
        """
        if not self.is_available():
            logger.error("TTS 未配置 API Key")
            return

        q: queue.Queue = queue.Queue()
        done = threading.Event()

        try:
            target_voice = voice or self.voice
            target_model = model or self.model
            target_format = format or self.format
            target_sr = sample_rate or self.sample_rate

            self._ensure_dashscope_config()
            audio_format = self._map_audio_format(target_format, target_sr)
            callback = _StreamCallback(q, done)

            synthesizer = SpeechSynthesizer(
                model=target_model,
                voice=target_voice,
                format=audio_format,
                speech_rate=speech_rate,
                pitch_rate=pitch_rate,
                callback=callback,
            )

            logger.info(
                f"[TTS-Stream] starting: model={target_model}, voice={target_voice}, "
                f"chunks={len(text_chunks)}"
            )

            # 启动流式合成：先建立连接
            synthesizer.streaming_call(text_chunks[0])
            for chunk in text_chunks[1:]:
                synthesizer.streaming_call(chunk)
            synthesizer.streaming_complete()

            # 把 queue 中的音频块 yield 出去，同时等待完成
            loop = asyncio.get_running_loop()

            def _get_nowait():
                chunks = []
                while True:
                    try:
                        chunks.append(q.get_nowait())
                    except queue.Empty:
                        break
                return chunks

            while True:
                # 让出主线程，等一小段时间让回调积累数据
                await asyncio.sleep(0.05)

                # 从 queue 取数据 yield 出去
                try:
                    chunks = await loop.run_in_executor(None, _get_nowait)
                    for chunk in chunks:
                        yield chunk
                except Exception:
                    pass

                # 检查是否完成
                if done.is_set():
                    # 完成前再清空一次 queue
                    try:
                        chunks = await loop.run_in_executor(None, _get_nowait)
                        for chunk in chunks:
                            yield chunk
                    except Exception:
                        pass
                    break

                # 超时保护
                if done.wait(timeout=0.1):
                    break

        except Exception as e:
            logger.exception(f"[TTS-Stream] 异常: {e}")
        finally:
            try:
                synthesizer.streaming_cancel()
            except Exception:
                pass

    def get_available_voices(self) -> dict:
        """返回参考音色列表（实际可用性与模型授权相关）"""
        return {
            "中文": {
                "longanhuan_v3.6": "中文口语女声（晓欢 v3.6）— 已验证",
                "longxiaochun_v2": "中文口语女声（晓春 v2）",
                "long_zh_standard": "中文标准女声",
                "long_zh_mild": "中文温柔女声",
            },
            "英文": {
                "long_en_standard": "英文标准女声",
                "loongmary": "英文欢快女声",
                "long_en_sad": "英文悲伤女声",
            },
            "其他": {
                "long_ja_standard": "日语标准女声",
                "long_ko_standard": "韩语标准女声",
            },
        }


# 全局实例
tts_service = TTSService()
