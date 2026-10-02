import axios from 'axios'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000/api'

// 创建 axios 实例
const apiClient = axios.create({
  baseURL: API_BASE_URL,
  timeout: 60000,
  headers: {
    'Content-Type': 'application/json',
  },
})

// 请求拦截器
apiClient.interceptors.request.use(
  (config) => {
    console.log(`API请求: ${config.method?.toUpperCase()} ${config.url}`)
    return config
  },
  (error) => {
    console.error('请求错误:', error)
    return Promise.reject(error)
  }
)

// 响应拦截器
apiClient.interceptors.response.use(
  (response) => {
    return response
  },
  (error) => {
    console.error('API错误:', error)
    
    // 处理特定的错误状态码
    if (error.response) {
      const { status, data } = error.response
      
      switch (status) {
        case 401:
          console.error('认证失败，请检查 API Key')
          break
        case 429:
          console.error('请求过于频繁，请稍后重试')
          break
        case 500:
          console.error('服务器错误:', data?.detail)
          break
        default:
          console.error(`请求失败 (${status}):`, data?.detail || error.message)
      }
    } else if (error.request) {
      console.error('网络错误，请检查服务器是否运行')
    }
    
    return Promise.reject(error)
  }
)

// API 接口定义
export const api = {
  // 健康检查
  healthCheck: async () => {
    try {
      const response = await apiClient.get('/health')
      return response.data
    } catch (error) {
      console.error('健康检查失败:', error)
      throw error
    }
  },

  // 语音对话
  voiceChat: async (audioData: string, sessionId?: string) => {
    try {
      const response = await apiClient.post('/chat/voice', {
        audio_data: audioData,
        session_id: sessionId,
      })
      return response.data
    } catch (error) {
      console.error('语音对话失败:', error)
      throw error
    }
  },

  // 文本对话
  textChat: async (text: string, sessionId?: string, generateSpeech: boolean = true) => {
    try {
      const response = await apiClient.post('/chat/text', {
        text,
        session_id: sessionId,
        generate_speech: generateSpeech,
      })
      return response.data
    } catch (error) {
      console.error('文本对话失败:', error)
      throw error
    }
  },

  // 初始化数字人
  initAvatar: async (userId: string, avatarId?: string) => {
    try {
      const response = await apiClient.post('/avatar/init', {
        user_id: userId,
        avatar_id: avatarId,
      })
      return response.data
    } catch (error) {
      console.error('初始化数字人失败:', error)
      throw error
    }
  },

  // 获取聊天历史
  getChatHistory: async (sessionId: string) => {
    try {
      const response = await apiClient.get('/chat/history', {
        params: { session_id: sessionId },
      })
      return response.data
    } catch (error) {
      console.error('获取聊天历史失败:', error)
      throw error
    }
  },

  // 列出所有 session（历史对话侧边栏用）
  listSessions: async () => {
    try {
      const response = await apiClient.get('/chat/sessions')
      return response.data
    } catch (error) {
      console.error('列出 session 失败:', error)
      throw error
    }
  },

  // 重命名 session
  updateSessionTitle: async (sessionId: string, title: string) => {
    try {
      const response = await apiClient.patch(`/chat/sessions/${sessionId}`, { title })
      return response.data
    } catch (error) {
      console.error('重命名 session 失败:', error)
      throw error
    }
  },

  // 保存一条语法检查结果
  saveGrammarCheck: async (
    sessionId: string,
    payload: { user_text: string; checks: Array<{ original: string; corrected: string; explanation: string }> }
  ) => {
    try {
      const response = await apiClient.post(`/chat/sessions/${sessionId}/grammar-check`, payload)
      return response.data
    } catch (error) {
      console.error('保存语法检查失败:', error)
      throw error
    }
  },

  // 清除聊天历史
  clearChatHistory: async (sessionId: string) => {
    try {
      const response = await apiClient.delete(`/chat/history/${sessionId}`)
      return response.data
    } catch (error) {
      console.error('清除聊天历史失败:', error)
      throw error
    }
  },

  // 上传音频文件
  uploadAudio: async (file: File, sessionId?: string) => {
    try {
      const formData = new FormData()
      formData.append('file', file)
      if (sessionId) {
        formData.append('session_id', sessionId)
      }
      
      const response = await apiClient.post('/upload/audio', formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
      })
      return response.data
    } catch (error) {
      console.error('上传音频失败:', error)
      throw error
    }
  },

  // 通用 TTS 合成：任意文本 → mp3 base64（用于"点击 AI 重读"功能）
  synthesizeText: async (
    text: string,
    options?: { voice?: string; speech_rate?: number; pitch_rate?: number }
  ): Promise<{ success: boolean; audio_data?: string; latency_ms?: number; error?: string }> => {
    try {
      const response = await apiClient.post('/config/tts/synthesize', {
        text,
        voice: options?.voice,
        speech_rate: options?.speech_rate,
        pitch_rate: options?.pitch_rate,
      })
      return response.data
    } catch (error) {
      console.error('TTS 合成失败:', error)
      throw error
    }
  },
}

// 音频工具函数
export const audioUtils = {
  // 将 Blob 转换为 Base64
  blobToBase64: (blob: Blob): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onloadend = () => {
        const base64 = reader.result as string
        // 移除 data:image/xxx;base64, 前缀
        const base64Data = base64.split(',')[1] || base64
        resolve(base64Data)
      }
      reader.onerror = reject
      reader.readAsDataURL(blob)
    })
  },

  // 将 Base64 转换为 Audio URL
  base64ToAudioUrl: (base64: string, mimeType: string = 'audio/mp3'): string => {
    return `data:${mimeType};base64,${base64}`
  },

  // 播放 Base64 音频
  playBase64Audio: async (base64: string, mimeType: string = 'audio/mp3'): Promise<void> => {
    return new Promise((resolve, reject) => {
      const audioUrl = audioUtils.base64ToAudioUrl(base64, mimeType)
      const audio = new Audio(audioUrl)
      
      audio.onended = () => resolve()
      audio.onerror = (error) => reject(error)
      
      audio.play()
    })
  },
}

export default api
