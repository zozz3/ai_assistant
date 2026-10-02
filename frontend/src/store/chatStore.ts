import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/** 语法纠错单条 */
export interface GrammarCheckItem {
  original: string
  corrected: string
  explanation: string
}

export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  /**
   * ✅ 新版：TTS 完成后才会写入。指向 IndexedDB 里存的音频 blob 的 URL
   * （URL.createObjectURL 创建），由 ChatInterface 加载显示。
   * 如果没有音频（还在生成中、或者 TTS 失败），值为 undefined。
   */
  audioUrl?: string
  /** @deprecated 不再使用，由 IndexedDB 替代 */
  audioData?: string
  /** @deprecated 不再使用，由 IndexedDB 替代 */
  audioChunks?: string[]
  /** 语法纠错：仅在 interview 场景下、且 LLM 检出错误时挂载在 user 消息上 */
  grammarCheck?: GrammarCheckItem[]
  timestamp: Date
}

/** 已支持的对话场景 */
export type SceneId = 'daily' | 'interview'

export const SCENE_LABELS: Record<SceneId, string> = {
  daily: '🗣️ 日常英语',
    interview: '💼 面试英语',
}

interface ChatState {
  messages: Message[]
  sessionId: string | null
  isLoading: boolean
  error: string | null
  isAvatarReady: boolean
  avatarState: 'idle' | 'listening' | 'thinking' | 'speaking'
  /** 当前选中的对话场景（会影响 LLM 的 system prompt） */
  activeScene: SceneId
  /** 当前正在录音 / 加载 TTS 的 assistant 消息 ID（用于 UI 实时显示"生成中"标记） */
  generatingMessageId: string | null

  // Actions
  addMessage: (message: Omit<Message, 'id' | 'timestamp'>) => void
  setMessages: (messages: Message[]) => void
  clearMessages: () => void
  setSessionId: (sessionId: string) => void
  setLoading: (isLoading: boolean) => void
  setError: (error: string | null) => void
  setAvatarReady: (ready: boolean) => void
  setAvatarState: (state: 'idle' | 'listening' | 'thinking' | 'speaking') => void
  setActiveScene: (scene: SceneId) => void
  /**
   * ✅ 新版：给指定 messageId 设置音频（object URL）。
   * 在 TTS 合成完毕 + 存到 IndexedDB 之后调用。
   */
  setMessageAudioUrl: (messageId: string, url: string | undefined) => void
  /** 给指定 user 消息附加语法纠错结果 */
  setMessageGrammarCheck: (messageId: string, checks: GrammarCheckItem[] | undefined) => void
  /** @deprecated 不再使用 */
  appendMessageAudio: (messageId: string, chunkBase64: string) => void
  setGeneratingMessageId: (id: string | null) => void
}

export const useChatStore = create<ChatState>()(
  persist(
    (set) => ({
      messages: [],
      sessionId: null,
      isLoading: false,
      error: null,
      isAvatarReady: false,
      avatarState: 'idle',
      activeScene: 'daily',
      generatingMessageId: null,

      addMessage: (message) =>
        set((state) => ({
          messages: [
            ...state.messages,
            {
              ...message,
              id: `${Date.now()}-${Math.random()}`,
              timestamp: new Date(),
            },
          ],
        })),

      setMessages: (messages) => set({ messages }),

      clearMessages: () => set({ messages: [], generatingMessageId: null }),

      setSessionId: (sessionId) => set({ sessionId }),

      setLoading: (isLoading) => set({ isLoading }),

      setError: (error) => set({ error }),

      setAvatarReady: (ready) => set({ isAvatarReady: ready }),

      setAvatarState: (avatarState) => set({ avatarState }),

      setActiveScene: (activeScene) => set({ activeScene }),

      setMessageAudioUrl: (messageId, url) =>
        set((state) => ({
          messages: state.messages.map((m) =>
            m.id === messageId ? { ...m, audioUrl: url } : m
          ),
        })),

      setMessageGrammarCheck: (messageId, checks) =>
        set((state) => ({
          messages: state.messages.map((m) =>
            m.id === messageId ? { ...m, grammarCheck: checks } : m
          ),
        })),

      // @deprecated 保留以兼容老代码
      appendMessageAudio: (_messageId, _chunkBase64) => {
        // 新版不再聚合 tts_chunk，TTS 由前端独立调用 + 存 IndexedDB
        // 保留空实现，避免老调用崩溃
      },

      setGeneratingMessageId: (id) => set({ generatingMessageId: id }),
    }),
    {
      name: 'chat-storage',
      // ✅ 不持久化音频 URL（每次启动从 IDB 重读出来）
      partialize: (state) => ({
        sessionId: state.sessionId,
        activeScene: state.activeScene,
        messages: state.messages.map((msg) => ({
          id: msg.id,
          role: msg.role,
          content: msg.content,
          timestamp: msg.timestamp.toString(),
          // audioUrl 不持久化（启动后从 IndexedDB 重读）
        })),
      }),
    }
  )
)