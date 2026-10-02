# coding=utf-8
"""
配置管理 API 路由
提供配置获取、保存、测试和延迟测量功能
"""
import base64
import logging
import time
from typing import Dict, Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .config_models import (
    ConfigModule,
    ConfigSaveRequest, ConfigSaveResponse,
    ConfigGetResponse,
    LatencyResponse,
    # LLM
    LLMConfig, LLMTestRequest, LLMTestResponse,
    # ASR
    ASRConfig, ASRTestRequest, ASRTestResponse,
    # TTS
    TTSConfig, TTSTestRequest, TTSTestResponse,
    # Avatar
    AvatarConfig, AvatarTestRequest, AvatarTestResponse,
    AvatarGenerateRequest, AvatarGenerateResponse, AvatarStatusResponse,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/config", tags=["配置管理"])


# ==================== 通用配置接口 ====================
# 注意：api_key / license / app_id 等敏感字段现在**直接返回明文**给前端。
# 原因：用户要求「保存后能回显明文」，因此前端必须拿到真实值。
# 浏览器 DevTools / 网络请求 body 中会包含明文 key，请确保前端部署在可信环境。
# 如需恢复 mask 行为，把下方 mask 块重新打开即可。


@router.get("/{module}", response_model=ConfigGetResponse)
async def get_module_config(module: ConfigModule):
    """
    获取指定模块的配置

    - **module**: 模块名称 (llm, asr, tts, avatar)
    """
    try:
        from services.config_service import config_service

        config = config_service.get_config(module.value)

        # ⚠️ 已关闭敏感字段 mask。下方为旧逻辑，保留以便回滚：
        # for k in SENSITIVE_FIELDS:
        #     if k in config and config[k]:
        #         config[k] = mask_api_key(config[k])

        return ConfigGetResponse(
            success=True,
            module=module.value,
            config=config
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Failed to get config for {module}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/save", response_model=ConfigSaveResponse)
async def save_module_config(request: ConfigSaveRequest):
    """
    保存指定模块的配置
    
    - **module**: 模块名称 (llm, asr, tts, avatar)
    - **config**: 配置数据
    """
    try:
        from services.config_service import config_service
        
        success = config_service.save_config(request.module.value, request.config)
        
        if success:
            return ConfigSaveResponse(
                success=True,
                message=f"{request.module.value.upper()} 配置保存成功",
                config=request.config
            )
        else:
            return ConfigSaveResponse(
                success=False,
                message="配置保存失败"
            )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Failed to save config for {request.module}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/{module}/latency", response_model=LatencyResponse)
async def measure_module_latency(module: ConfigModule):
    """
    测量指定模块的响应延迟
    
    - **module**: 模块名称 (llm, asr, tts, avatar)
    """
    try:
        from services.config_service import config_service
        
        latency, status = await config_service.measure_latency(module.value)
        
        return LatencyResponse(
            success=status != "error",
            module=module.value,
            latency_ms=latency,
            status=status
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Failed to measure latency for {module}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ==================== LLM 配置接口 ====================

@router.post("/llm/test", response_model=LLMTestResponse)
async def test_llm(request: LLMTestRequest):
    """
    测试 LLM 大模型配置
    
    - **config**: LLM 配置
    - **test_prompt**: 测试提示词（可选）
    """
    try:
        from services.config_service import config_service
        
        config_dict = request.config.model_dump()
        success, response, latency, error = await config_service.test_llm(config_dict)
        
        return LLMTestResponse(
            success=success,
            response=response,
            latency_ms=latency,
            error=error
        )
    except Exception as e:
        logger.error(f"LLM test failed: {e}")
        return LLMTestResponse(
            success=False,
            error=str(e)
        )


# ==================== ASR 配置接口 ====================

@router.post("/asr/test", response_model=ASRTestResponse)
async def test_asr(request: ASRTestRequest):
    """
    测试 ASR 语音识别配置

    - **config**: ASR 配置
    """
    try:
        from services.config_service import config_service

        config_dict = request.config.model_dump()
        success, recognized, latency, error = await config_service.test_asr(config_dict)

        # 流式识别相关校验（不真正建立 WS，仅配置项校验）
        streaming_supported = bool(request.config.api_key)
        streaming_note = None
        if not streaming_supported:
            streaming_note = "缺少 API Key，无法启用流式识别"
        elif request.config.streaming_model and "streaming" not in request.config.streaming_model:
            streaming_note = (
                f"当前流式模型 `{request.config.streaming_model}` 名称不含 streaming，"
                "建议使用官方推荐模型 qwen-audio-3.0-asr-flash-streaming"
            )
        elif request.config.workspace_id:
            streaming_note = (
                f"已配置 Workspace ID={request.config.workspace_id}，将使用北京地域 WSS"
            )

        return ASRTestResponse(
            success=success,
            recognized_text=recognized,
            latency_ms=latency,
            error=error,
            streaming_supported=streaming_supported,
            streaming_note=streaming_note,
        )
    except Exception as e:
        logger.exception("ASR test endpoint error")
        return ASRTestResponse(
            success=False,
            error=str(e),
        )


# ==================== TTS 配置接口 ====================

@router.post("/tts/test", response_model=TTSTestResponse)
async def test_tts(request: TTSTestRequest):
    """
    测试 TTS 语音合成配置
    
    - **config**: TTS 配置
    - **test_text**: 测试文本（可选）
    """
    try:
        from services.config_service import config_service
        
        config_dict = request.config.model_dump()
        success, audio_data, latency, error = await config_service.test_tts(config_dict)
        
        # 将音频数据转换为 Base64
        audio_base64 = None
        if audio_data and isinstance(audio_data, str):
            audio_base64 = audio_data
        
        return TTSTestResponse(
            success=success,
            audio_data=audio_base64,
            latency_ms=latency,
            error=error
        )
    except Exception as e:
        logger.error(f"TTS test failed: {e}")
        return TTSTestResponse(
            success=False,
            error=str(e)
        )


# ==================== 通用 TTS 合成接口（用于"重读上一句"）===================

class SynthesizeRequest(BaseModel):
    """任意文本 → TTS 合成请求"""
    text: str
    voice: Optional[str] = None  # 不传则用 config_service 保存的 voice
    speech_rate: Optional[float] = None
    pitch_rate: Optional[float] = None


class SynthesizeResponse(BaseModel):
    success: bool
    audio_data: Optional[str] = None  # base64 mp3
    latency_ms: Optional[float] = None
    error: Optional[str] = None


@router.post("/tts/synthesize", response_model=SynthesizeResponse)
async def synthesize_text(request: SynthesizeRequest):
    """
    把任意文本合成为 mp3，返回 base64。
    用于前端"点击 AI 消息重读"功能：UI 调用此端点拿到 mp3，再喂给数字人。

    使用 config_service 中保存的 TTS 配置（api_key / voice / model / sample_rate），
    仅允许通过请求体临时覆盖 speech_rate / pitch_rate / voice。
    """
    try:
        from services.config_service import config_service
        from services.tts_service import tts_service

        text = (request.text or "").strip()
        if not text:
            return SynthesizeResponse(success=False, error="text 不能为空")
        if len(text) > 2000:
            return SynthesizeResponse(success=False, error="text 过长（>2000 字符）")

        # 同步 reload 配置（确保后端用最新 voice/model，reload_runtime_config 内部从 config_service 读）
        tts_service.reload_runtime_config()

        start = time.time()
        audio_bytes = await tts_service.synthesize(
            text,
            voice=request.voice,
            speech_rate=request.speech_rate if request.speech_rate is not None else 1.0,
            pitch_rate=request.pitch_rate if request.pitch_rate is not None else 1.0,
        )
        latency_ms = (time.time() - start) * 1000.0

        if not audio_bytes:
            return SynthesizeResponse(
                success=False,
                error="TTS 合成失败（可能 voice 非法，请到设置页测试连接）",
                latency_ms=latency_ms,
            )

        return SynthesizeResponse(
            success=True,
            audio_data=base64.b64encode(audio_bytes).decode("ascii"),
            latency_ms=latency_ms,
        )
    except Exception as e:
        logger.error(f"synthesize_text failed: {e}")
        return SynthesizeResponse(success=False, error=str(e))


# ==================== Avatar 配置接口 ====================

@router.post("/avatar/test", response_model=AvatarTestResponse)
async def test_avatar(request: AvatarTestRequest):
    """
    测试 Avatar 播报模板配置（不消耗资源）— 校验 templateId 是否有效，返回模板的动态变量列表

    - **config**: Avatar 配置（template_id 必填）
    """
    try:
        from services.config_service import config_service
        config_dict = request.config.model_dump()
        # 新签名：(success, template_id, template_name, variables_list_or_error)
        success, template_id, template_name, payload = await config_service.test_avatar(config_dict)
        if success:
            # payload 是 variables_list
            variables = payload if isinstance(payload, list) else []
            return AvatarTestResponse(
                success=True,
                template_id=template_id,
                template_name=template_name,
                variables=variables,
            )
        else:
            return AvatarTestResponse(
                success=False,
                error=str(payload) if not isinstance(payload, list) else "未知错误",
            )
    except Exception as e:
        logger.error(f"Avatar test failed: {e}")
        return AvatarTestResponse(success=False, error=str(e))


@router.get("/avatar/templates")
async def list_avatar_templates(page: int = 1, size: int = 20):
    """
    列举当前阿里云账号下的所有播报模板（用于 UI 下拉选择 templateId）

    - **page**: 页码（从 1 开始）
    - **size**: 每页大小（默认 20）
    """
    try:
        from services.config_service import config_service
        success, templates, error = await config_service.get_avatar_templates(page=page, size=size)
        return {
            "success": success,
            "templates": templates or [],
            "error": error,
        }
    except Exception as e:
        logger.error(f"List avatar templates failed: {e}")
        return {"success": False, "templates": [], "error": str(e)}


@router.post("/avatar/generate", response_model=AvatarGenerateResponse)
async def generate_avatar_video(request: AvatarGenerateRequest):
    """
    提交播报视频合成任务（异步）

    - **config**: Avatar 配置
    - **text_variables**: 文本变量值，例 {"slide_script": "你好世界"}
    """
    try:
        from services.config_service import config_service
        config_dict = request.config.model_dump()
        success, task_id, video_id, error = await config_service.generate_avatar_video(
            config=config_dict,
            text_variables=request.text_variables or {},
        )
        return AvatarGenerateResponse(
            success=success,
            task_id=task_id,
            video_id=video_id,
            error=error,
        )
    except Exception as e:
        logger.error(f"Avatar generate failed: {e}")
        return AvatarGenerateResponse(success=False, error=str(e))


@router.get("/avatar/status/{task_id}", response_model=AvatarStatusResponse)
async def get_avatar_status(task_id: str):
    """
    查询播报视频合成任务状态（前端轮询）

    - **task_id**: /avatar/generate 返回的本地任务 ID
    """
    try:
        from services.config_service import config_service
        success, status_dict, error = await config_service.poll_avatar_video(task_id)
        if not success:
            return AvatarStatusResponse(success=False, task_id=task_id, error=error)
        return AvatarStatusResponse(
            success=True,
            task_id=status_dict.get("task_id"),
            video_id=status_dict.get("video_id"),
            status=status_dict.get("status"),
            progress=status_dict.get("progress"),
            video_url=status_dict.get("video_url"),
        )
    except Exception as e:
        logger.error(f"Avatar status failed: {e}")
        return AvatarStatusResponse(success=False, task_id=task_id, error=str(e))


# ==================== 辅助函数 ====================

def mask_api_key(api_key: str) -> str:
    """掩码 API Key，只显示前4位和后4位"""
    if len(api_key) <= 8:
        return "*" * len(api_key)
    return f"{api_key[:4]}{'*' * (len(api_key) - 8)}{api_key[-4:]}"
