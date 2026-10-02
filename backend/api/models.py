# coding=utf-8
"""
Pydantic数据模型定义
"""
from pydantic import BaseModel, Field
from typing import Optional, List, Dict, Any
from enum import Enum


class VoiceChatMode(str, Enum):
    """语音对话模式"""
    TAP2TALK = "tap2talk"  # 点击说话
    DUPLEX = "duplex"      # 全双工


class VoiceRequest(BaseModel):
    """语音输入请求"""
    audio_data: str = Field(..., description="Base64编码的音频数据")
    session_id: Optional[str] = Field(None, description="对话会话ID")
    format: Optional[str] = Field("wav", description="音频格式")
    sample_rate: Optional[int] = Field(16000, description="采样率")


class VoiceResponse(BaseModel):
    """语音响应"""
    text: str = Field(..., description="识别的文本")
    reply_text: str = Field(..., description="AI回复文本")
    audio_data: Optional[str] = Field(None, description="Base64编码的语音响应")
    session_id: str = Field(..., description="会话ID")


class AvatarInitRequest(BaseModel):
    """数字人初始化请求"""
    user_id: str = Field(..., description="用户ID")
    avatar_id: Optional[str] = Field(None, description="数字人ID")


class AvatarInitResponse(BaseModel):
    """数字人初始化响应"""
    session_id: str = Field(..., description="会话ID")
    rtc_params: Dict[str, Any] = Field(..., description="RTC参数")
    avatar_params: Dict[str, Any] = Field(..., description="数字人参数")


class ChatMessage(BaseModel):
    """聊天消息"""
    role: str = Field(..., description="角色: user, assistant, system")
    content: str = Field(..., description="消息内容")
    audio_data: Optional[str] = Field(None, description="可选的音频数据")
    timestamp: Optional[str] = Field(None, description="ISO 时间戳")


class ChatHistoryRequest(BaseModel):
    """聊天历史请求"""
    session_id: str = Field(..., description="会话ID")


class ChatHistoryResponse(BaseModel):
    """聊天历史响应"""
    messages: List[ChatMessage] = Field(default_factory=list, description="消息列表")
    session_id: str = Field(..., description="会话ID")


class ErrorResponse(BaseModel):
    """错误响应"""
    error: str = Field(..., description="错误信息")
    detail: Optional[str] = Field(None, description="详细错误信息")


class HealthResponse(BaseModel):
    """健康检查响应"""
    status: str = Field(default="healthy")
    version: str = Field(default="1.0.0")
    services: Dict[str, str] = Field(default_factory=dict)


class TextRequest(BaseModel):
    """文本输入请求"""
    text: str = Field(..., description="输入文本")
    session_id: Optional[str] = Field(None, description="会话ID")
    generate_speech: bool = Field(True, description="是否生成语音")


class TextResponse(BaseModel):
    """文本响应"""
    reply_text: str = Field(..., description="AI回复文本")
    audio_data: Optional[str] = Field(None, description="Base64编码的语音响应")
    session_id: str = Field(..., description="会话ID")


# ========================= 流式对话管道事件 =========================

class PipelineEventType(str, Enum):
    """管道事件类型（与前端 useChatStream 一一对应）"""
    READY = "ready"                  # 服务端就绪（WS 接受后立即发）
    ASR_PARTIAL = "asr_partial"      # ASR 临时识别（边录边显示）
    ASR_SENTENCE_END = "asr_sentence_end"  # ASR 一句话结束
    USER_TEXT_FINAL = "user_text_final"    # 用户最终文本（含整段语音刚脱口的）
    LLM_START = "llm_start"          # LLM 开始生成
    LLM_DELTA = "llm_delta"          # LLM token 流
    LLM_SENTENCE = "llm_sentence"    # 一个完整句子（供 TTS 用）
    LLM_DONE = "llm_done"            # LLM 完整结束
    TTS_CHUNK = "tts_chunk"          # 一段 mp3 base64（喂数字人）
    TTS_SENTENCE = "tts_sentence"    # 当前句子 TTS 完成
    TTS_DONE = "tts_done"            # 所有 TTS 完成
    PIPELINE_DONE = "pipeline_done"  # 整轮对话结束
    AVATAR_STATE = "avatar_state"    # 状态机切换：listening / thinking / speaking
    ERROR = "error"
    PONG = "pong"


class PipelineEvent(BaseModel):
    """通用管道事件（所有 ws 消息都用这个结构）"""
    type: PipelineEventType
    session_id: Optional[str] = None
    text: Optional[str] = None            # 增量文本
    sentence_index: Optional[int] = None  # 句子序号（关联 llm_sentence / tts_chunk / tts_sentence）
    audio_data: Optional[str] = None      # base64 mp3
    format: Optional[str] = "mp3"
    sample_rate: Optional[int] = 24000
    state: Optional[str] = None           # avatar_state 事件用
    metrics: Optional[Dict[str, Any]] = None
    message: Optional[str] = None         # 错误信息
