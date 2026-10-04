import { useCallback, useEffect, useRef, useState } from 'react'
import { Avatar } from './components/Avatar'
import { VoiceInput } from './components/VoiceInput'
import { ChatInterface } from './components/ChatInterface'
import { HistorySidebar, type SessionMeta } from './components/HistorySidebar'
import { StatusIndicator } from './components/StatusIndicator'
import { SettingsPage } from './components/SettingsPage'
import { useAvatar } from './hooks/useAvatar'
import { useChatStream } from './hooks/useChatStream'
import { useChatStore } from './store/chatStore'
import { api } from './services/api'
import { saveAudioFromBase64, loadAudio } from './services/audioStorage'
import type { GrammarCheckItem } from './store/chatStore'

type AppView = 'main' | 'settings'

/**
 * 从 LLM 输出里抽取 <grammar>...</grammar> 块，返回干净文本 + 纠错列表
 * 规则：
 *  - 标签内必须是合法 JSON 数组
 *  - 解析失败时返回原文 + 空数组
 *  - ✅ 容错：模型只输出开标签没闭合 → 也能剥离并尝试解析
 */
function parseGrammarBlock(
  raw: string
): { cleanText: string; grammarChecks: GrammarCheckItem[] } {
  if (!raw) return { cleanText: '', grammarChecks: [] }
  const match = raw.match(/<grammar>([\s\S]*?)<\/grammar>/i)
  if (!match) {
    // ✅ 兜底：只有开标签没有闭标签（流式被截断 / 模型没写闭标签）
    const dangling = raw.match(/<grammar>([\s\S]*)$/i)
    if (dangling) {
      const cleanText = raw.replace(/<grammar>[\s\S]*$/gi, '').trim()
      return { cleanText, grammarChecks: parseGrammarJson(dangling[1]) }
    }
    return { cleanText: raw.trim(), grammarChecks: [] }
  }
  const cleanText = raw.replace(/<grammar>[\s\S]*?<\/grammar>/gi, '').trim()
  return { cleanText, grammarChecks: parseGrammarJson(match[1]) }
}

/** 解析 <grammar> 块内的 JSON 数组；容错常见 LLM 格式错误 */
function parseGrammarJson(json: string): GrammarCheckItem[] {
  if (!json) return []
  const body = json.trim()
  if (!body) return []
  const normalize = (arr: unknown): GrammarCheckItem[] => {
    if (!Array.isArray(arr)) return []
    return arr
      .filter(
        (x) =>
          x &&
          typeof x.original === 'string' &&
          typeof x.corrected === 'string' &&
          typeof x.explanation === 'string'
      )
      .map((x) => ({
        original: x.original,
        corrected: x.corrected,
        explanation: x.explanation,
      }))
  }
  try {
    return normalize(JSON.parse(body))
  } catch (e) {
    console.warn('[parseGrammarBlock] JSON 解析失败，尝试修复:', e)
    try {
      // 常见错误：结尾多余逗号
      return normalize(JSON.parse(body.replace(/,\s*([\]}])/g, '$1')))
    } catch {
      return []
    }
  }
}

/**
 * ✅ 剥离 <grammar> 块，用于**实时预览气泡**（不是最终消息）
 *
 * 重要区分：
 *  - 最终消息气泡：正文显示 cleanText，纠错以卡片形式渲染在【用户消息下方】
 *  - 实时预览气泡（VoiceInput）：只是"AI 正在说"的打字机预览，
 *    如果显示 grammar JSON 会很难看，所以这里剥离
 *  - TTS / 数字人朗读：必须剥离，否则会把 JSON 念出来
 */
function stripGrammarBlock(raw: string): string {
  if (!raw) return ''
  // 完整块
  let out = raw.replace(/<grammar>[\s\S]*?<\/grammar>/gi, '')
  // 未闭合的（正在流式输出 grammar JSON 时）
  out = out.replace(/<grammar>[\s\S]*$/gi, '')
  return out.trim()
}

function App() {
  const {
    setSessionId,
    setMessages,
    addMessage,
    setMessageAudioUrl,
    setMessageGrammarCheck,
    setGeneratingMessageId,
    setLoading,
    setError,
    setAvatarState,
    avatarState,
    isAvatarReady,
    clearMessages,
    activeScene,
    setActiveScene,
  } = useChatStore()

  const { initAvatar, exitAvatar, feedAvatarAudio } = useAvatar()
  const [isInitialized, setIsInitialized] = useState(false)
  const [currentView, setCurrentView] = useState<AppView>('main')
  const [historyOpen, setHistoryOpen] = useState(false)

  // ✅ 历史恢复时暂存 grammar 纠错：assistant 消息里带 <grammar> 块，
  // 需要解析后挂到它【前面那条 user 消息】上。setMessages 是整体替换，
  // 所以必须先收集再二次 setMessageGrammarCheck。
  const historyGrammarRef = useRef<
    { userIndex: number; checks: GrammarCheckItem[] }[]
  >([])

  // ===== 流式对话管道 =====
  // ✅ 关键改动：后端不再推 tts_chunk，TTS 由前端在收到 pipeline_done 后独立完成：
  //   pipeline_done (含完整文本) → api.synthesizeText(text)
  //     → 存到 IndexedDB → saveAudioFromBase64
  //     → 把 object URL 写到 store.audioUrl
  //     → 立即 feedAvatarAudio(audioData) 驱动数字人
  const {
    interimText,
    llmText,
    error: streamError,
    startConversation,
    stopConversation,
  } = useChatStream({
    language: 'en',
    onUserTextFinal: (text) => {
      if (!text) return
      addMessage({ role: 'user', content: text })
    },
    onAvatarState: (state) => {
      setAvatarState(state)
    },
    onLlmStart: () => {
      // LLM 开始 → 立即创建 assistant 占位消息
      addMessage({ role: 'assistant', content: '' })
      // ✅ 修复：从 store 最新值找刚加的 assistant（不用闭包的 messages.length）
      const msgs = useChatStore.getState().messages
      const lastAssistant = [...msgs].reverse().find((m) => m.role === 'assistant')
      setGeneratingMessageId(lastAssistant?.id || null)
      console.log(
        '[App] onLlmStart: store.length=',
        msgs.length,
        'genId=',
        lastAssistant?.id
      )
    },
    /**
     * ✅ 新版：pipeline_done 时，前端独立跑 TTS + 存 IDB + 驱动数字人
     * 同时解析 <grammar> 块（仅 interview 场景）→ 挂到对应 user 消息上
     */
    onPipelineDone: async (replyText) => {
      const genId = useChatStore.getState().generatingMessageId
      console.log(
        '[App] onPipelineDone 触发:',
        replyText?.slice(0, 40),
        '... genId=',
        genId
      )

      // 0) ✅ 先解析 grammar 块（必须在修改 text 之前）
      const { cleanText, grammarChecks } = parseGrammarBlock(replyText || '')
      // grammar 是挂在 user 消息上的，找到对应的 user 消息 = assistant 消息的前一条 user
      if (grammarChecks.length > 0) {
        const msgs = useChatStore.getState().messages
        // 找到 generating 的 assistant 前面那条 user 消息
        const asstIdx = msgs.findIndex((m) => m.id === genId)
        if (asstIdx > 0) {
          // 倒着找最近的 user
          for (let i = asstIdx - 1; i >= 0; i--) {
            if (msgs[i].role === 'user') {
              setMessageGrammarCheck(msgs[i].id, grammarChecks)
              console.log(
                `[App] ✓ grammar check 挂到 user msg ${msgs[i].id.slice(-6)}:`,
                grammarChecks
              )
              // ✅ 同步存到后端
              const sid = useChatStore.getState().sessionId
              if (sid) {
                api
                  .saveGrammarCheck(sid, {
                    user_text: msgs[i].content,
                    checks: grammarChecks,
                  })
                  .catch((e) => console.warn('[App] save grammar check 失败:', e))
              }
              break
            }
          }
        }
      }

      // 1) 先更新 assistant 文本（用去掉 grammar 块的干净文本）
      if (genId) {
        const cur = useChatStore.getState().messages
        setMessages(
          cur.map((m) =>
            m.id === genId ? { ...m, content: cleanText } : m
          )
        )
      } else {
        // genId 缺失兜底：找最后一条 assistant
        const msgs = useChatStore.getState().messages
        const lastAssistant = [...msgs].reverse().find((m) => m.role === 'assistant')
        if (lastAssistant) {
          setMessages(
            msgs.map((m) =>
              m.id === lastAssistant.id ? { ...m, content: cleanText } : m
            )
          )
          setGeneratingMessageId(lastAssistant.id)
        }
      }

      const effectiveGenId = useChatStore.getState().generatingMessageId
      if (!effectiveGenId || !cleanText.trim()) {
        console.warn('[App] pipeline_done: genId 或文本为空，跳过 TTS')
        setGeneratingMessageId(null)
        setLoading(false)
        return
      }

      try {
        // 2) 前端主动调 TTS（独立 HTTP 路径）
        // ✅ 关键修复：必须用 cleanText（已剥离 <grammar> 块），否则数字人会把
        // 原始 JSON（original/corrected/explanation）当正文念出来
        console.log('[App] → 调用 /api/config/tts/synthesize 合成干净文本')
        const result = await api.synthesizeText(cleanText.trim())
        if (!result.success || !result.audio_data) {
          console.error('[App] synthesizeText 失败:', result.error)
          setError(`自动播报失败：${result.error || 'TTS 合成失败'}`)
          setGeneratingMessageId(null)
          setLoading(false)
          return
        }

        // 3) 存到 IndexedDB（持久化到本地）
        const saved = await saveAudioFromBase64(
          effectiveGenId,
          'assistant',
          replyText,
          result.audio_data
        )

        // 4) 把 object URL 写到 store（ChatInterface 用 <audio> 展示）
        setMessageAudioUrl(effectiveGenId, saved.url)

        // 5) ✅ 关键：立即把 mp3 base64 喂给数字人
        console.log('[App] → 立即 feedAvatarAudio 驱动数字人')
        feedAvatarAudio(result.audio_data)
          .then(() => console.log('[App] ✓ 数字人驱动完成'))
          .catch((e) => console.error('[App] ✗ 数字人驱动抛异常:', e))
      } catch (e: any) {
        console.error('[App] pipeline_done 处理异常:', e)
        setError(`自动播报失败：${e?.message || e}`)
      } finally {
        setGeneratingMessageId(null)
        setLoading(false)
      }
    },
    onError: (msg) => {
      setError(`对话错误: ${msg}`)
      setGeneratingMessageId(null)
      setLoading(false)
    },
  })

  // 把 hook 内部错误也透到 store
  useEffect(() => {
    if (streamError) setError(streamError)
  }, [streamError, setError])

  // ===== 初始化数字人（支持指定 session_id；不传则用当前 store 里的）=====
  const handleInitAvatar = useCallback(
    async (overrideSessionId?: string) => {
      try {
        setLoading(true)

        // ✅ 如果指定了 sessionId，先用指定；否则用 store 现有的；都没有就 new
        const existingSid = useChatStore.getState().sessionId
        const sidToUse = overrideSessionId || existingSid

        // api.initAvatar() 返回 response.data（后端根对象）
        // ✅ 关键：把当前 session_id 传过去，后端就不会新生成
        const initResp = await api.initAvatar(
          `user_${Date.now()}`,
          sidToUse || undefined
        )
        const { session_id, rtc_params } = initResp as any
        setSessionId(session_id)

        // ✅ 拉这个 session 的历史（后端从磁盘读，刷新页面/重启后仍能恢复）
        try {
          const histResp = await api.getChatHistory(session_id)
          const msgs = (histResp as any)?.messages || []
          if (Array.isArray(msgs) && msgs.length > 0) {
            setMessages(
              msgs.map((m: any, i: number) => {
                const raw = m.content || ''
                // ✅ 历史里的 assistant 消息可能含 <grammar> 块（后端完整存了原文），
                // 直接渲染会出现裸 JSON。这里解析出干净正文 + 纠错列表，
                // 纠错按位置挂回它前面的那条 user 消息。
                if (m.role === 'assistant') {
                  const { cleanText, grammarChecks } = parseGrammarBlock(raw)
                  if (grammarChecks.length > 0) {
                    historyGrammarRef.current.push({
                      userIndex: i - 1, // grammar 挂在前一条 user 上
                      checks: grammarChecks,
                    })
                  }
                  return {
                    id: `hist-${session_id}-${i}-${m.timestamp || ''}`,
                    role: 'assistant' as const,
                    content: cleanText,
                    timestamp: m.timestamp ? new Date(m.timestamp) : new Date(),
                  }
                }
                return {
                  id: `hist-${session_id}-${i}-${m.timestamp || ''}`,
                  role: 'user' as const,
                  content: raw,
                  timestamp: m.timestamp ? new Date(m.timestamp) : new Date(),
                }
              })
            )
            // ✅ 把历史里的纠错挂到对应的 user 消息上
            const withChecks = useChatStore.getState().messages
            for (const entry of historyGrammarRef.current) {
              const target = withChecks[entry.userIndex]
              if (target && target.role === 'user') {
                setMessageGrammarCheck(target.id, entry.checks)
              }
            }
            historyGrammarRef.current = []
            console.log(`[App] 恢复了 ${msgs.length} 条历史消息`)

            // ✅ 并行从 IDB 恢复每条 assistant 的音频
            const restored = useChatStore.getState().messages
            for (const m of restored) {
              if (m.role !== 'assistant') continue
              loadAudio(m.id).then((rec) => {
                if (rec) {
                  setMessageAudioUrl(m.id, rec.url)
                }
              })
            }
          } else {
            setMessages([])
          }
        } catch (histErr) {
          console.warn('[App] 加载历史失败（不影响初始化）:', histErr)
        }

        await initAvatar(rtc_params as any)
        setIsInitialized(true)
      } catch (error: any) {
        console.error('初始化失败:', error)
        const detail =
          error?.response?.data?.detail ||
          error?.message ||
          String(error)
        setError(`初始化失败: ${detail}`)
      } finally {
        setLoading(false)
      }
    },
    [
      initAvatar,
      setSessionId,
      setMessages,
      setMessageAudioUrl,
      setMessageGrammarCheck,
      setLoading,
      setError,
    ]
  )

  // ===== 麦克风按下/松开 → start/stop 流式对话 =====
  const handleVoiceStart = useCallback(async () => {
    if (!isAvatarReady) {
      setError('请先初始化数字人')
      return
    }
    setLoading(true)
    try {
      // ✅ 把当前场景 ID 传给后端，后端注入对应的 system prompt
      await startConversation(activeScene)
    } catch (e: any) {
      setError(`启动对话失败: ${e?.message || String(e)}`)
      setLoading(false)
    }
  }, [isAvatarReady, startConversation, activeScene, setLoading, setError])

  const handleVoiceStop = useCallback(() => {
    stopConversation()
    // setLoading(false) 会由 onPipelineDone 回调处理
  }, [stopConversation])

  // ===== 错误回调 =====
  const handleError = useCallback(
    (error: string) => {
      setError(error)
    },
    [setError]
  )

  // ===== "新对话" 按钮：保存当前 → 清空 → 等用户再点"初始化" =====
  //   当前对话已经在磁盘（_append_history_and_trim 自动保存），所以"保存"是隐式完成的
  //   真正要做的是：退出数字人连接 + 清空 messages + 清空 sessionId（下次 initAvatar 会生成新的）
  //   直接走 handleNewSession；UI 上加 confirm 避免误触
  // （handleNewSession 在下方声明）

  // ===== 完全退出数字人：回到初始化前的界面 =====
  const handleExitAvatar = useCallback(() => {
    console.log('[App] 退出数字人，重置到初始状态')
    try {
      exitAvatar()
    } catch (e) {
      console.error('[App] exitAvatar 异常:', e)
    }
    // 清空消息 + session
    clearMessages()
    setSessionId('')
    // 重置 UI 状态
    setIsInitialized(false)
    setError(null)
    setAvatarState('idle' as any)
  }, [exitAvatar, clearMessages, setSessionId, setError, setAvatarState])

  // ===== 新建对话：清空当前 → 自动初始化 =====
  const handleNewSession = useCallback(() => {
    console.log('[App] 新建对话')
    try {
      exitAvatar()
    } catch (e) {
      console.warn('[App] exitAvatar 异常（继续）:', e)
    }
    clearMessages()
    setSessionId('')
    setIsInitialized(false)
    setError(null)
    setAvatarState('idle' as any)
    setGeneratingMessageId(null)
    // 不自动调 initAvatar，让用户点"初始化"按钮
  }, [exitAvatar, clearMessages, setSessionId, setError, setAvatarState, setGeneratingMessageId])

  // ===== 从侧边栏选择历史对话：复用该 session =====
  const handleSelectSession = useCallback(
    async (sid: string, _meta: SessionMeta) => {
      console.log('[App] 切换到历史对话:', sid)
      // 如果当前正在跑，退出
      try {
        exitAvatar()
      } catch (e) {
        console.warn('[App] exitAvatar 异常（继续）:', e)
      }
      clearMessages()
      setSessionId(sid)
      setGeneratingMessageId(null)
      setIsInitialized(false)
      setError(null)
      setAvatarState('idle' as any)
      // 场景跟着 meta 走
      if (_meta.scene) setActiveScene(_meta.scene)
      // 自动重新初始化（带 session_id 复用）
      await handleInitAvatar(sid)
    },
    [exitAvatar, clearMessages, setSessionId, setError, setAvatarState, setGeneratingMessageId, setActiveScene, handleInitAvatar]
  )

  // ===== 删除当前 session 后清理 =====
  const handleSessionDeleted = useCallback(
    (sid: string) => {
      const cur = useChatStore.getState().sessionId
      if (cur === sid) {
        // 删除的就是当前对话 → 重置
        clearMessages()
        setSessionId('')
        setIsInitialized(false)
      }
    },
    [clearMessages, setSessionId]
  )

  // ===== 点击 AI 消息重读：把那段文本走 TTS → 喂数字人 → 缓存到 IDB =====
  const handleRepeatSpeak = useCallback(
    async (text: string, _messageId: string) => {
      if (!text || !text.trim()) return
      // ✅ 兜底去掉 <grammar> 标签再送 TTS，否则数字人会把标签念出来
      const cleanText = text.replace(/<grammar>[\s\S]*?<\/grammar>/gi, '').trim()
      if (!cleanText) return
      console.log('[App] handleRepeatSpeak:', cleanText.slice(0, 40))
      try {
        const result = await api.synthesizeText(cleanText)
        if (result.success && result.audio_data) {
          // 把 mp3 base64 解码 + 重采样 + 喂给 Simli（与正常 TTS 路径完全一致）
          await feedAvatarAudio(result.audio_data)
          // ✅ 也存到 IDB，方便下次回看（不强制 await）
          saveAudioFromBase64(_messageId, 'assistant', cleanText, result.audio_data)
            .then((saved) => {
              setMessageAudioUrl(_messageId, saved.url)
              console.log('[App] 重读音频已缓存到 IDB')
            })
            .catch((e) => console.warn('[App] 重读缓存失败（不影响继续）:', e))
        } else {
          console.error('[App] synthesizeText 失败:', result.error)
          setError(`重读失败：${result.error || 'TTS 合成失败'}`)
        }
      } catch (e: any) {
        console.error('[App] handleRepeatSpeak 异常:', e)
        setError(`重读失败：${e?.message || e}`)
      }
    },
    [feedAvatarAudio, setError, setMessageAudioUrl]
  )

  const handleOpenSettings = useCallback(() => {
    setCurrentView('settings')
  }, [])

  // 卸载清理
  useEffect(() => {
    return () => {
      exitAvatar()
    }
  }, [exitAvatar])

  // 如果显示设置页面
  if (currentView === 'settings') {
    console.log('[App] Rendering SettingsPage')
    return (
      <div style={{ minHeight: '100vh', background: 'linear-gradient(to bottom right, #581c87, #1e3a8a, #312e81)', color: 'white' }}>
        {/* 设置页面顶部导航条 */}
        <div style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(10px)', borderBottom: '1px solid rgba(255,255,255,0.1)', position: 'sticky', top: 0, zIndex: 100 }}>
          <div style={{ maxWidth: '1200px', margin: '0 auto', padding: '16px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
              <button
                onClick={() => { console.log('[App] Back to main'); setCurrentView('main') }}
                style={{ padding: '10px 20px', background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: '8px', color: 'white', fontWeight: 500, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '14px' }}
              >
                <span style={{ fontSize: '20px' }}>←</span>
                <span>返回对话</span>
              </button>
              <h1 style={{ fontSize: '24px', fontWeight: 'bold', margin: 0 }}>⚙️ 模块配置</h1>
            </div>
            <div style={{ color: 'rgba(255,255,255,0.6)', fontSize: '14px' }}>
              English Speaking Coach v1.0.0
            </div>
          </div>
        </div>
        {/* SettingsPage 内容容器 */}
        <div style={{ padding: '24px', minHeight: 'calc(100vh - 80px)' }}>
          <SettingsPage />
        </div>
      </div>
    )
  }

  // 主对话界面
  // ✅ 微信式：外层固定 100vh，内部主区占满剩余空间 → 不会出现整个网页的滚动条
  return (
    <div className="h-screen w-screen flex flex-col bg-gradient-to-br from-purple-900 via-blue-900 to-indigo-900">
      {/* 历史对话侧边栏（覆盖在主内容之上） */}
      <HistorySidebar
        isOpen={historyOpen}
        onClose={() => setHistoryOpen(false)}
        currentSessionId={useChatStore.getState().sessionId}
        onSelectSession={handleSelectSession}
        onNewSession={handleNewSession}
        onSessionDeleted={handleSessionDeleted}
      />

      {/* 顶部全局配置按钮 */}
      <div className="flex justify-between px-4 pt-3 pb-2 flex-shrink-0">
        <button
          onClick={() => setHistoryOpen(true)}
          className="px-4 py-2 bg-white/10 hover:bg-white/20 active:bg-white/30 text-white rounded-lg font-medium transition-all shadow flex items-center space-x-2 cursor-pointer backdrop-blur"
          title="查看历史对话"
        >
          <span className="text-lg">📚</span>
          <span className="text-sm">历史</span>
        </button>
        <button
          onClick={handleOpenSettings}
          className="px-5 py-2 bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white rounded-lg font-medium transition-all shadow-lg flex items-center space-x-2 cursor-pointer"
          style={{ zIndex: 100 }}
        >
          <span className="text-xl">⚙️</span>
          <span>API 配置</span>
        </button>
      </div>

      {/* 主容器 — flex-1 占满剩余高度，内部两栏各占 1/2 */}
      <div className="flex-1 min-h-0 px-4 pb-4">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 h-full">
          {/* 左侧：数字人 */}
          <div className="flex flex-col gap-3 min-h-0">
            <div className="card flex-1 flex flex-col min-h-0 overflow-hidden">
              <div className="flex items-center justify-between mb-3 flex-shrink-0">
                <h2 className="text-xl font-bold text-gray-800">
                  🎭 AI Speaking Coach
                </h2>
                <StatusIndicator />
              </div>

              <div className="flex-1 min-h-0">
                <Avatar
                  className="h-full"
                  isActive={isInitialized && isAvatarReady}
                  state={avatarState as any}
                />
              </div>
            </div>

            {/* 控制按钮 */}
            <div className="flex space-x-3 flex-shrink-0">
              {!isInitialized ? (
                <button
                  onClick={() => handleInitAvatar()}
                  className="btn-primary flex-1"
                >
                  初始化数字人
                </button>
              ) : (
                <>
                  <button
                    onClick={() => {
                      if (confirm('开始新对话？当前对话会自动保存到「历史」中。')) {
                        handleNewSession()
                      }
                    }}
                    className="btn-secondary flex-1"
                    title="把当前对话保存到历史，并开始新对话"
                  >
                    ✨ 新对话
                  </button>
                  <button
                    onClick={handleExitAvatar}
                    className="btn-secondary flex-1"
                  >
                    ⏹️ 退出
                  </button>
                </>
              )}
            </div>
          </div>

          {/* 右侧：聊天界面 */}
          <div className="card flex flex-col min-h-0 overflow-hidden">
            <div className="flex items-center justify-between mb-3 flex-shrink-0">
              <h2 className="text-xl font-bold text-gray-800">
                💬 Conversation
              </h2>

              {/* ✅ 场景切换 */}
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-400 font-medium">场景:</span>
                <div className="flex rounded-lg overflow-hidden border border-gray-200 text-xs">
                  {(['daily', 'interview'] as const).map((sid) => (
                    <button
                      key={sid}
                      onClick={() => setActiveScene(sid)}
                      className={`px-3 py-1.5 transition-all ${
                        activeScene === sid
                          ? 'bg-blue-600 text-white font-semibold'
                          : 'bg-white text-gray-600 hover:bg-gray-50'
                      }`}
                    >
                      {sid === 'daily' ? '🗣️ 日常' : '💼 面试'}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* ✅ 聊天消息区 — flex-1 + min-h-0 + overflow-y-auto：固定大小，溢出出滚动条 */}
            <div className="flex-1 min-h-0 overflow-hidden">
              <ChatInterface onRepeatSpeak={handleRepeatSpeak} />
            </div>

            {/* 语音输入（固定在底部，不折叠） */}
            <div className="border-t pt-3 mt-3 flex-shrink-0">
              <VoiceInput
                onStart={handleVoiceStart}
                onStop={handleVoiceStop}
                onError={handleError}
                interimText={interimText}
                llmText={stripGrammarBlock(llmText)}
                avatarState={avatarState}
                disabled={!isInitialized}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default App