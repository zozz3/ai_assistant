// 配置管理 API
import axios from 'axios'

const API_BASE_URL =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) || 'http://localhost:8000/api'

const apiClient = axios.create({
  baseURL: API_BASE_URL,
  timeout: 60000,
  headers: { 'Content-Type': 'application/json' },
})

// 配置模块类型
export type ConfigModule = 'llm' | 'asr' | 'tts' | 'avatar'

// 通用配置响应
export interface ConfigResponse<T = any> {
  success: boolean
  module?: string
  config?: T
  message?: string
}

// LLM 配置
export interface LLMConfig {
  provider: string
  api_key: string
  base_url: string
  model: string
  temperature: number
  max_tokens: number
  system_prompt: string
}

// ASR 配置
export interface ASRConfig {
  provider: string
  api_key: string
  model: string
  streaming_model: string
  language: string
  format: string
  sample_rate: number
  workspace_id: string
  enable_streaming: boolean
  semantic_punctuation_enabled: boolean
}

// TTS 配置
export interface TTSConfig {
  provider: string
  api_key: string
  model: string
  voice: string
  format: string
  sample_rate: number
  speech_rate: number
  pitch_rate: number
  workspace_id: string
}

// Avatar 配置
export interface AvatarConfig {
  provider: string
  app_id: string
  api_key: string
  server_user_id: string
  avatar_id: string
  avatar_name: string
  enable_avatar: boolean
}

// 延迟测试响应
export interface LatencyResponse {
  success: boolean
  module: string
  latency_ms: number
  status: string
}

// 测试响应基础接口
interface TestResponseBase {
  success: boolean
  latency_ms?: number
  error?: string
}

// LLM 测试响应
export interface LLMTestResponse extends TestResponseBase {
  response?: string
}

// ASR 测试响应
export interface ASRTestResponse extends TestResponseBase {
  recognized_text?: string
  streaming_supported?: boolean
  streaming_note?: string
}

// TTS 测试响应
export interface TTSTestResponse extends TestResponseBase {
  audio_data?: string
}

// Avatar 测试响应
export interface AvatarTestResponse extends TestResponseBase {
  session_id?: string
  rtc_params?: Record<string, any>
}

// 配置管理 API
export const configApi = {
  // 获取配置
  async getConfig<T = any>(module: ConfigModule): Promise<ConfigResponse<T>> {
    const response = await apiClient.get(`/config/${module}`)
    return response.data
  },

  // 保存配置
  async saveConfig(module: ConfigModule, config: any): Promise<ConfigResponse> {
    const response = await apiClient.post('/config/save', {
      module,
      config
    })
    return response.data
  },

  // 测试配置
  async testConfig(module: ConfigModule, config: any): Promise<any> {
    const response = await apiClient.post(`/config/${module}/test`, config)
    return response.data
  },

  // 测量延迟
  async measureLatency(module: ConfigModule): Promise<LatencyResponse> {
    const response = await apiClient.get(`/config/${module}/latency`)
    return response.data
  },

  // LLM 测试
  async testLLM(config: LLMConfig, testPrompt?: string): Promise<LLMTestResponse> {
    const response = await apiClient.post('/config/llm/test', {
      config,
      test_prompt: testPrompt
    })
    return response.data
  },

  // ASR 测试
  async testASR(config: ASRConfig): Promise<ASRTestResponse> {
    const response = await apiClient.post('/config/asr/test', {
      config
    })
    return response.data
  },

  // TTS 测试
  async testTTS(config: TTSConfig, testText?: string): Promise<TTSTestResponse> {
    const response = await apiClient.post('/config/tts/test', {
      config,
      test_text: testText
    })
    return response.data
  },

  // Avatar 测试
  async testAvatar(config: AvatarConfig): Promise<AvatarTestResponse> {
    const response = await apiClient.post('/config/avatar/test', {
      config
    })
    return response.data
  }
}

export default configApi
