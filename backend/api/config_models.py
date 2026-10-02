# coding=utf-8
"""
Pydantic数据模型定义 - 配置相关
"""
from pydantic import BaseModel, Field
from typing import Optional, List, Dict, Any
from enum import Enum


# ==================== 配置模块枚举 ====================
class ConfigModule(str, Enum):
    """配置模块类型"""
    LLM = "llm"           # 大语言模型
    ASR = "asr"           # 语音识别
    TTS = "tts"           # 语音合成
    AVATAR = "avatar"     # 数字人方案


# ==================== LLM 配置 ====================
class LLMConfig(BaseModel):
    """LLM 大模型配置"""
    provider: str = Field(default="openai", description="提供商: openai, dashscope, deepseek")
    api_key: str = Field(default="", description="API Key")
    base_url: str = Field(
        default="https://api.deepseek.com",  # 已验证
        description="API Base URL（默认 DeepSeek，已实机验证）",
    )
    model: str = Field(
        default="deepseek-flash",  # 已验证
        description="模型名称（默认 deepseek-flash，已实机验证）",
    )
    temperature: float = Field(default=0.7, ge=0, le=2, description="温度参数")
    max_tokens: int = Field(default=500, ge=1, le=4000, description="最大Token数")
    system_prompt: str = Field(default="", description="系统提示词")


class LLMTestRequest(BaseModel):
    """LLM测试请求"""
    config: LLMConfig
    test_prompt: str = Field(default="Hello, please respond with 'OK' to confirm the connection is working.", description="测试提示词")


class LLMTestResponse(BaseModel):
    """LLM测试响应"""
    success: bool
    response: Optional[str] = None
    latency_ms: Optional[float] = None
    error: Optional[str] = None


# ==================== ASR 配置 ====================
class ASRConfig(BaseModel):
    """ASR 语音识别配置

    支持两种识别模式：
    - batch：批量识别（整段音频文件，对应 dashscope.audio.asr.asr_call）
    - stream：流式识别（基于 WebSocket，对应 dashscope.audio.asr.Recognition）
    """
    provider: str = Field(default="dashscope", description="提供商: dashscope, azure, google")
    api_key: str = Field(default="", description="DashScope API Key")
    model: str = Field(default="qwen-audio-3.1-asr-flash", description="批量识别模型")
    streaming_model: str = Field(
        default="qwen-audio-3.0-asr-flash-streaming",  # 已验证
        description="流式识别模型（默认 qwen-audio-3.0-asr-flash-streaming，已实机验证）",
    )
    language: str = Field(default="en", description="识别语言: en / zh / ja / auto")
    format: str = Field(default="wav", description="音频格式: wav / pcm / mp3 / opus / speex / aac / amr")
    sample_rate: int = Field(default=16000, description="采样率: 8000 或 16000")
    workspace_id: str = Field(
        default="ws-9u11sow24b78mx0w",  # 已验证
        description="阿里云业务空间 ID（默认 ws-9u11sow24b78mx0w，北京地域已实机验证）",
    )
    enable_streaming: bool = Field(default=True, description="是否启用流式识别（默认开）")
    semantic_punctuation_enabled: bool = Field(default=False, description="是否启用语义断句（仅流式）")


class ASRTestRequest(BaseModel):
    """ASR测试请求"""
    config: ASRConfig


class ASRTestResponse(BaseModel):
    """ASR测试响应"""
    success: bool
    recognized_text: Optional[str] = None
    latency_ms: Optional[float] = None
    error: Optional[str] = None
    streaming_supported: bool = False
    streaming_note: Optional[str] = None


# ==================== TTS 配置 ====================
class TTSConfig(BaseModel):
    """TTS 语音合成配置（对齐阿里云 dashscope.audio.tts_v2 SDK）"""
    provider: str = Field(default="dashscope", description="提供商: dashscope")
    api_key: str = Field(default="", description="DashScope API Key")
    model: str = Field(
        default="qwen-audio-3.0-tts-flash",  # 已验证
        description="模型名称（默认 qwen-audio-3.0-tts-flash，已实机验证）",
    )
    voice: str = Field(
        default="longanhuan_v3.6",  # 已验证
        description="音色名称（默认 longanhuan_v3.6，已实机验证）",
    )
    format: str = Field(default="mp3", description="输出格式: mp3 / pcm / wav")
    sample_rate: int = Field(default=22050, description="采样率（mp3 推荐 22050Hz，已验证）")
    speech_rate: float = Field(default=1.0, ge=0.5, le=2.0, description="语速")
    pitch_rate: float = Field(default=1.0, ge=0.5, le=2.0, description="音调")
    workspace_id: str = Field(default="", description="阿里云业务空间 ID（默认地域可不填）")


class TTSTestRequest(BaseModel):
    """TTS测试请求"""
    config: TTSConfig
    test_text: str = Field(default="Hello, this is a test message.", description="测试文本")


class TTSTestResponse(BaseModel):
    """TTS测试响应"""
    success: bool
    audio_data: Optional[str] = None  # Base64编码的音频
    latency_ms: Optional[float] = None
    error: Optional[str] = None


# ==================== Avatar 配置 ====================
class AvatarConfig(BaseModel):
    """数字人方案配置（支持两种模式）

    **模式 A：播报视频合成**（不需要实时交互实例，一次性出片）
        官方文档：https://help.aliyun.com/zh/avatar/avatar-application/developer-reference/developer-guide-broadcast-video-generation
        流程：
            1. 在「视频创作工作台」创建播报模板，定义动态变量（text/image/audio/avatar/voice）
            2. ListBroadcastTemplates → 取 templateId
            3. CreateBroadcastVideoFromTemplate(templateId, variables) → videoId
            4. ListBroadcastVideosById 轮询 → SUCCESS 时返回 videoUrl
        所需字段：template_id

    **模式 B：云渲染音频驱动（WebSDK）**（实时流 + 可打断 + TTS 直推）
        官方文档：https://help.aliyun.com/zh/avatar/avatar-application/developer-reference/digital-people-conversation-cloud-render-audio-driver-websdk
        流程：
            1. CreateChatSession(projectId, instanceId[, license, platform]) → rtcParams
            2. 前端用 lm-avatar-chat-sdk 的 createAvatar(TYAvatarType.cloudAvatar, rtcParams)
            3. avatar.start({ mode: tap2talk }) → avatar.pushAudioData(pcm) 驱动播报
        所需字段：project_id + instance_id（license/platform 仅端渲染需要，云渲染可省略）
    """
    provider: str = Field(default="alibaba_wanxiang", description="提供商: alibaba_wanxiang / simli")

    # === 方案选择 ===
    mode: str = Field(
        default="video",
        description="数字人方案: video=播报视频合成（异步出片） / realtime=云渲染音频驱动（实时流）",
    )

    # === 模式 A：播报模板 ID ===
    template_id: str = Field(
        default="",
        description="[模式A] 播报模板 ID（在视频创作工作台「我的视频」→ 复制 ID 获取）",
    )

    # === 模式 C：Simli + LiveKit 实时数字人 ===
    # 文档：https://docs.simli.com/overview
    # 实际 WebRTC 连接由独立 LiveKit agent worker（avatar_agents/simli_agent.py）建立
    simli_api_key: str = Field(
        default="",
        description="[Simli] API Key（https://www.simli.com/ Profile 页获取）",
    )
    simli_face_id: str = Field(
        default="",
        description="[Simli] Face ID（https://www.simli.com/characters 选一个角色）",
    )

    # === 模式 B：云渲染实时会话 ===
    project_id: str = Field(
        default="",
        description="[模式B] 对话数字人项目 ID（万相数字人控制台 → 对话互动页获取）",
    )
    instance_id: str = Field(
        default="",
        description="[模式B] 实时交互服务实例 ID（购买「实时数字人交互」服务后，在「我的订单」详情查询）",
    )
    license: Optional[str] = Field(
        default=None,
        description="[模式B·仅端渲染] 万相数字人平台颁发的 license",
    )
    platform: Optional[str] = Field(
        default=None,
        description="[模式B·仅端渲染] 运行平台，一般填 web",
    )

    # === 业务开关 ===
    enable_avatar: bool = Field(default=False, description="是否启用数字人")

    # === 兼容旧字段（已废弃） ===
    app_id: Optional[str] = Field(default=None, description="[已废弃] 等同于 project_id")
    api_key: Optional[str] = Field(default=None, description="[已废弃] 等同于 license")
    server_user_id: Optional[str] = Field(default=None, description="[已废弃]")
    avatar_id: Optional[str] = Field(default=None, description="[已废弃]")
    avatar_name: Optional[str] = Field(default=None, description="[已废弃]")


class AvatarTestRequest(BaseModel):
    """数字人测试请求"""
    config: AvatarConfig


class AvatarTestResponse(BaseModel):
    """数字人测试响应（按 mode 返回不同字段）"""
    success: bool
    # 模式 A
    template_id: Optional[str] = None
    template_name: Optional[str] = None
    variables: Optional[list] = None
    # 模式 B
    session_id: Optional[str] = None
    rtc_params: Optional[Dict[str, Any]] = None
    error: Optional[str] = None


class AvatarSessionRequest(BaseModel):
    """云渲染实时会话请求（模式 B）

    参考官方 WebSDK 文档的 IAvatarInitConfig：
        appId / channel / timestamp / token / clientUserId /
        serverUserId / avatarUserId / sessionId / rootContainer
    全部由后端 CreateChatSession 返回，前端直接喂给 createAvatar()。
    """
    config: AvatarConfig
    # 客户端入会 id（前端生成，用于 RTC 入会）
    client_user_id: Optional[str] = Field(
        default=None,
        description="客户端入会 id。不填则由后端自动生成",
    )
    client_user_name: Optional[str] = Field(default=None, description="客户端入会 name（业务自定义）")


class AvatarSessionResponse(BaseModel):
    """云渲染实时会话响应"""
    success: bool
    session_id: Optional[str] = None
    rtc_params: Optional[Dict[str, Any]] = None
    error: Optional[str] = None


class AvatarGenerateRequest(BaseModel):
    """数字人视频生成请求（异步任务）"""
    config: AvatarConfig
    # 用户输入的动态变量值
    text_variables: Dict[str, str] = Field(
        default_factory=dict,
        description="文本变量值，例如 {\"slide_script\": \"你好世界\"}",
    )


class AvatarGenerateResponse(BaseModel):
    """数字人视频生成响应（提交后立即返回）"""
    success: bool
    task_id: Optional[str] = None          # 本地任务 ID
    video_id: Optional[str] = None         # 阿里云视频 ID
    error: Optional[str] = None


class AvatarStatusResponse(BaseModel):
    """数字人视频状态查询响应"""
    success: bool
    task_id: Optional[str] = None
    video_id: Optional[str] = None
    status: Optional[str] = None           # PENDING / PROCESSING / SUCCESS / FAILED
    progress: Optional[int] = None         # 0-100
    video_url: Optional[str] = None        # 合成成功后返回
    cover_url: Optional[str] = None        # 封面图
    caption_url: Optional[str] = None      # 字幕 SRT
    error: Optional[str] = None


class AvatarPublicTemplate(BaseModel):
    """阿里云公共预置播报场景模板"""
    id: str
    name: str


class AvatarCopyTemplateRequest(BaseModel):
    """把公共预置模板复制到自己账号"""
    template_id: str = Field(description="公共预置模板 ID")
    name: str = Field(description="复制后的模板名称")
    ratio: str = Field(default="16:9", description="画面比例: 16:9 / 9:16")


class AvatarCopyTemplateResponse(BaseModel):
    """复制模板结果"""
    success: bool
    template_id: Optional[str] = None
    template_name: Optional[str] = None
    variables: Optional[list] = None
    error: Optional[str] = None


# ==================== 通用响应 ====================
class ConfigSaveRequest(BaseModel):
    """配置保存请求"""
    module: ConfigModule
    config: Dict[str, Any]  # 通用配置字典


class ConfigSaveResponse(BaseModel):
    """配置保存响应"""
    success: bool
    message: str
    config: Optional[Dict[str, Any]] = None


class ConfigGetResponse(BaseModel):
    """配置获取响应"""
    success: bool
    module: str
    config: Dict[str, Any]


class LatencyResponse(BaseModel):
    """延迟测试响应"""
    success: bool
    module: str
    latency_ms: float
    status: str
