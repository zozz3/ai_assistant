import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * 端到端流式对话管道 hook
 *
 * 单次会话生命周期：
 *   1) startConversation() → 连 ws → 发 start → 浏览器采集麦克风 (16kHz mono Int16)
 *      → 持续 send audio 帧给 ws
 *   2) stopConversation()  → 发 stop → 等 server 跑 LLM + TTS → 收 tts_chunk → 喂数字人
 *
 * 后端 WS: /api/chat/stream
 * 服务端协议事件：ready / asr_partial / asr_sentence_end / user_text_final /
 *   avatar_state / llm_start / llm_delta / llm_sentence / llm_done /
 *   tts_chunk / tts_sentence / tts_done / pipeline_done / error / pong
 */

interface PipelineEvent {
  type: string
  session_id?: string
  text?: string
  sentence_index?: number
  audio_data?: string
  format?: string
  sample_rate?: number
  state?: string
  metrics?: Record<string, any>
  message?: string
}

export type AvatarState = 'idle' | 'listening' | 'thinking' | 'speaking'

export interface UseChatStreamOptions {
  language?: string
  wsBaseUrl?: string
  sessionId?: string

  /**
   * 收到后端推来的 TTS mp3 块时调用。
   * 默认实现：什么都不做（让调用方通过 onTtsChunk 传入 feedAvatarAudio）。
   * 重要：这里只做"转交"，不要 await；hook 内部不阻塞下一段 TTS。
   */
  onTtsChunk?: (mp3Base64: string, sentenceIndex: number) => void | Promise<void>

  /** 用户文本最终落定 */
  onUserTextFinal?: (text: string) => void
  /** ASR 边录边显示的临时识别 */
  onAsrPartial?: (text: string) => void
  /** 状态机切换 */
  onAvatarState?: (state: AvatarState) => void
  /** LLM 流式 token */
  onLlmDelta?: (token: string) => void
  /** LLM 开始生成（用于前端预先创建 assistant 占位消息） */
  onLlmStart?: () => void
  /** 整轮对话完成（含 LLM + TTS） */
  onPipelineDone?: (replyText: string) => void
  /** 错误 */
  onError?: (msg: string) => void
  /** 对话场景（影响 LLM system prompt），从 useChatStore.activeScene 读取 */
  sceneId?: string
}

export interface UseChatStreamReturn {
  isConnected: boolean
  isRecording: boolean
  isPipelineRunning: boolean
  interimText: string
  userFinalText: string | null
  llmText: string
  error: string | null
  startConversation: (sceneId?: string) => Promise<void>
  stopConversation: () => void
  reset: () => void
}

/** 把任意 0..1 区间做线性插值映射；通过字符串端点 */
function axisAlignedMap(value: string): string {
  // 占位（保持原文件 import 结构，未来可加更多映射）
  return value
}

export const useChatStream = (opts: UseChatStreamOptions = {}): UseChatStreamReturn => {
  const wsRef = useRef<WebSocket | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  // ✅ 用 ref 防 startConversation 重入竞态：state 是异步刷新的，连续两次
  // 用户手势会拿到同一份旧 state（isRecording=true）→ 早返回 → 第二次永远起不来
  const busyRef = useRef(false)

  const [isConnected, setIsConnected] = useState(false)
  const [isRecording, setIsRecording] = useState(false)
  const [isPipelineRunning, setIsPipelineRunning] = useState(false)
  const [interimText, setInterimText] = useState('')
  const [userFinalText, setUserFinalText] = useState<string | null>(null)
  const [llmText, setLlmText] = useState('')
  const [error, setError] = useState<string | null>(null)

  // 用 ref 把 callback 锁住最新值，避免 ws.onmessage 闭包过期
  const cbTtsChunkRef = useRef(opts.onTtsChunk)
  const cbUserTextFinalRef = useRef(opts.onUserTextFinal)
  const cbAsrPartialRef = useRef(opts.onAsrPartial)
  const cbAvatarStateRef = useRef(opts.onAvatarState)
  const cbLlmDeltaRef = useRef(opts.onLlmDelta)
  const cbLlmStartRef = useRef(opts.onLlmStart)
  const cbPipelineDoneRef = useRef(opts.onPipelineDone)
  const cbErrorRef = useRef(opts.onError)
  useEffect(() => {
    cbTtsChunkRef.current = opts.onTtsChunk
    cbUserTextFinalRef.current = opts.onUserTextFinal
    cbAsrPartialRef.current = opts.onAsrPartial
    cbAvatarStateRef.current = opts.onAvatarState
    cbLlmDeltaRef.current = opts.onLlmDelta
    cbLlmStartRef.current = opts.onLlmStart
    cbPipelineDoneRef.current = opts.onPipelineDone
    cbErrorRef.current = opts.onError
  }, [
    opts.onTtsChunk,
    opts.onUserTextFinal,
    opts.onAsrPartial,
    opts.onAvatarState,
    opts.onLlmDelta,
    opts.onLlmStart,
    opts.onPipelineDone,
    opts.onError,
  ])

  // ============== 工具 ==============

  const getWsBase = useCallback((): string => {
    if (opts.wsBaseUrl) return opts.wsBaseUrl
    const envBase = import.meta.env.VITE_WS_BASE_URL as string | undefined
    if (envBase) return envBase
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    return `${proto}://${window.location.host}/api/chat/stream`
  }, [opts.wsBaseUrl])

  /** 关闭麦克风 / ws / audio context */
  const teardown = useCallback(() => {
    try {
      processorRef.current?.disconnect()
    } catch {
      /* noop */
    }
    try {
      mediaStreamRef.current?.getTracks().forEach((t) => t.stop())
    } catch {
      /* noop */
    }
    try {
      audioCtxRef.current?.close()
    } catch {
      /* noop */
    }
    processorRef.current = null
    mediaStreamRef.current = null
    audioCtxRef.current = null
    setIsRecording(false)
  }, [])

  // ============== 启动 ==============

  const startConversation = useCallback(async (sceneId?: string) => {
    console.log('[ChatStream] startConversation 被调用, isRecording=', isRecording, 'isConnected=', isConnected)
    // ✅ 用 busyRef 代替 state 守卫：避免 React state 异步刷新导致的"刚 stop 完再 start 被吞掉"
    if (busyRef.current) {
      console.warn('[ChatStream] startConversation 早返回 (busy=true)')
      return
    }
    busyRef.current = true
    console.log('[ChatStream] startConversation: 开始')
    setError(null)
    setInterimText('')
    setUserFinalText(null)
    setLlmText('')

    // ✅ 场景 ID：从入参 / opts.sceneId / 默认为 daily
    const activeSceneId = sceneId || opts.sceneId || 'daily'

    const wsBase = getWsBase()
    console.log('[ChatStream] ws base url =', wsBase, 'sceneId=', activeSceneId)
    const ws = new WebSocket(wsBase)
    wsRef.current = ws
    console.log('[ChatStream] WebSocket 已创建, readyState =', ws.readyState)

    ws.onopen = () => {
      console.log('[ChatStream-DIAG] ws.onopen 触发, readyState=', ws.readyState)
      setIsConnected(true)
      ws.send(
        JSON.stringify({
          type: 'start',
          session_id: opts.sessionId || `chat_${Date.now()}`,
          language: opts.language || 'en',
          scene_id: activeSceneId,
        })
      )
      console.log('[ChatStream-DIAG] 已发送 start 消息, scene_id=', activeSceneId)
    }

    // ws 超时检测：如果 5 秒后还没连上，说明 proxy 有问题
    const wsTimeout = setTimeout(() => {
      if (ws.readyState === WebSocket.CONNECTING) {
        console.error('[ChatStream-DIAG] ⚠️ ws 超时未连接 (5s)，readyState=CONNECTING，可能是 Vite proxy 未开启 ws 支持')
        ws.close()
        const msg = 'WebSocket 连接超时（5s），请检查 Vite proxy 配置'
        setError(msg)
        cbErrorRef.current?.(msg)
      }
    }, 5000)
    ws.addEventListener('open', () => clearTimeout(wsTimeout))

    ws.onerror = (e) => {
      console.error('[ChatStream-DIAG] ws.onerror', e)
      clearTimeout(wsTimeout)
      const msg = 'WebSocket 连接失败，请确认后端 /api/chat/stream 可达'
      setError(msg)
      cbErrorRef.current?.(msg)
      setIsConnected(false)
      // ✅ onerror 兜底释放 busy（onerror 通常紧接着 onclose，但保险起见）
      busyRef.current = false
    }

    ws.onclose = (e) => {
      console.log('[ChatStream-DIAG] ws.onclose code=', e.code, 'reason=', e.reason)
      clearTimeout(wsTimeout)
      setIsConnected(false)
      teardown()
      // ✅ 兜底释放 busy，否则异常关闭后再 start 会永远早返回
      busyRef.current = false
    }

    ws.onmessage = async (e) => {
      console.log('[ChatStream] ws.onmessage type=', (() => { try { return JSON.parse(e.data).type } catch { return '?' } })())
      let ev: PipelineEvent
      try {
        ev = JSON.parse(e.data) as PipelineEvent
      } catch {
        return
      }
      switch (ev.type) {
        case 'ready':
          console.log('[ChatStream-DIAG] ws.onmessage: ready')
          break
        case 'asr_partial':
          console.log('[ChatStream-DIAG] ws.onmessage: asr_partial text=', ev.text)
          setInterimText(ev.text || '')
          cbAsrPartialRef.current?.(ev.text || '')
          break
        case 'asr_sentence_end':
          console.log('[ChatStream-DIAG] ws.onmessage: asr_sentence_end text=', ev.text)
          // 累计一句（不覆盖 partial）
          setInterimText('')
          break
        case 'user_text_final':
          console.log('[ChatStream-DIAG] ws.onmessage: user_text_final text=', ev.text)
          setUserFinalText(ev.text || '')
          setIsPipelineRunning(true)
          cbUserTextFinalRef.current?.(ev.text || '')
          break
        case 'avatar_state':
          console.log('[ChatStream-DIAG] ws.onmessage: avatar_state=', ev.state)
          cbAvatarStateRef.current?.((ev.state as AvatarState) || 'idle')
          break
        case 'llm_start':
          setLlmText('')
          cbLlmStartRef.current?.()
          break
        case 'llm_delta':
          setLlmText((prev) => prev + (ev.text || ''))
          cbLlmDeltaRef.current?.(ev.text || '')
          break
        case 'llm_sentence':
        case 'llm_done':
        case 'tts_sentence':
        case 'tts_done':
          // 这些事件目前不需要在 hook 内更新 UI
          break
        case 'tts_chunk': {
          // ✅ 已废弃：当前架构下后端不再推 tts_chunk
          // TTS 由前端在收到 pipeline_done 的完整文本后，主动调
          // /api/config/tts/synthesize 合成（独立路径，不依赖 ws 流水线）
          // 保留这个 case 只是兜底：如果后端版本不匹配，老消息不会让前端崩
          console.warn('[useChatStream] 收到过时的 tts_chunk 事件，已忽略')
          break
        }
        case 'pipeline_done':
          setIsPipelineRunning(false)
          // ✅ 关键：AI 说完了 → 清空临时气泡。
          // 之前 llmText 只在 llm_start 清空，导致「正在听 / AI 正在说」那块
          // 实时预览会一直挂到下一轮录音才消失。
          // 最终正文 + 纠错卡片已经渲染进 ChatInterface 的消息列表了，这里只需清场。
          setInterimText('')
          setLlmText('')
          cbPipelineDoneRef.current?.(ev.text || '')
          break
        case 'error':
          setError(ev.message || 'unknown error')
          cbErrorRef.current?.(ev.message || 'unknown error')
          break
        case 'pong':
          break
        default:
          console.warn('[useChatStream] 未知事件:', ev.type, ev)
      }
    }

    // ✅ 修复：删掉之前在文件底部重复注册的 ws.onerror / ws.onclose，
    // 它们会覆盖掉上面带 console.log 和 clearTimeout(wsTimeout) 的版本。
    // 统一只在这一处注册 handler，避免二次会话时旧的 onclose 比新的 teardown 先执行、
    // 以及 clearTimeout 失效导致 wsTimeout 触发误报。
    void ws

    // 启动麦克风（独立 await，不阻塞 startConversation 整体返回）
  // ws 是异步连接，audio 帧自然会在 ws.open 之后才开始发送（onaudioprocess 内部已 guard）
  const startMicrophone = async (ws: WebSocket): Promise<void> => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      })
      mediaStreamRef.current = stream
      const AudioCtx =
        (window as any).AudioContext || (window as any).webkitAudioContext
      console.log('[ChatStream] 拿到新 MediaStream, tracks=', stream.getTracks().map(t => `${t.kind}:${t.readyState}`).join(','))
      const ctx = new AudioCtx({ sampleRate: 16000 })
      console.log('[ChatStream] 创建新 AudioContext, state=', ctx.state)
      // AudioWorklet/ScriptProcessor 在用户首次手势后仍可能被 Chrome 自动 suspend
      if (ctx.state === 'suspended') {
        try {
          await ctx.resume()
          console.log('[ChatStream] AudioContext.resume() 完成, state=', ctx.state)
        } catch (e) {
          console.warn('[ChatStream] AudioContext.resume() 失败:', e)
        }
      }
      // ===== 监听麦克风 track 状态变化（断线/被抢会自动 stop） =====
      const audioTrack = stream.getAudioTracks()[0]
      if (audioTrack) {
        audioTrack.addEventListener('ended', () => {
          const msg = `麦克风断开连接（track.ended），已自动停止录音。原因：${
            audioTrack.readyState === 'ended' ? '设备掉线 / 权限被收回' : '未知'
          }`
          console.warn('[ChatStream]', msg)
          setError(msg)
          cbErrorRef.current?.(msg)
          // 主动调用 teardown 释放资源
          teardown()
          try {
            wsRef.current?.close()
          } catch {
            /* noop */
          }
          busyRef.current = false
        })
      }
      audioCtxRef.current = ctx
      const source = ctx.createMediaStreamSource(stream)
      // ScriptProcessor 已 deprecated，但兼容性最好；后续可换 AudioWorklet
      const processor = ctx.createScriptProcessor(4096, 1, 1)
      processorRef.current = processor
      source.connect(processor)
      processor.connect(ctx.destination)
      ;(window as any).__processor = processor
      ;(window as any).__audioCtx = ctx
      processor.onaudioprocess = (e: AudioProcessingEvent) => {
        const wsNow = wsRef.current
        if (!wsNow || wsNow.readyState !== WebSocket.OPEN) {
          // ws 还没连上，静默丢弃这一帧（不连帧头都无）
          return
        }
        const input = e.inputBuffer.getChannelData(0)
        // 快速求 RMS 看是不是真的录到声音（不是静音）
        let sum = 0
        for (let i = 0; i < input.length; i++) sum += input[i] * input[i]
        const rms = Math.sqrt(sum / input.length)
        ;(window as any).__lastAudioRms = rms
        const pcm = new Int16Array(input.length)
        for (let i = 0; i < input.length; i++) {
          const s = Math.max(-1, Math.min(1, input[i]))
          pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff
        }
        const bytes = new Uint8Array(pcm.buffer)
        let binary = ''
        for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i])
        const b64 = btoa(binary)
        ;(window as any).__audioFramesSent = ((window as any).__audioFramesSent || 0) + 1
        wsNow.send(JSON.stringify({ type: 'audio', data: b64 }))
      }
      setIsRecording(true)
      console.log('[ChatStream] 麦克风已启动，等待 ws.onopen 后开始采集')
    } catch (micErr: any) {
      // ===== 麦克风异常分类处理（细分错误类型，给用户精确提示） =====
      // 参考: https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia#exceptions
      const name = micErr?.name || ''
      const rawMsg = micErr?.message || String(micErr)
      let msg: string
      switch (name) {
        case 'NotAllowedError':
        case 'PermissionDeniedError':
          msg = '麦克风权限被拒绝。请在浏览器地址栏左侧的锁形图标中允许麦克风权限，然后刷新页面。'
          break
        case 'NotFoundError':
        case 'DevicesNotFoundError':
          msg = '未检测到麦克风设备。请确认麦克风已连接，并允许浏览器使用。'
          break
        case 'NotReadableError':
        case 'TrackStartError':
          msg = '麦克风被其他程序占用（Zoom / 飞书 / 钉钉 等）。请关闭其他应用后重试。'
          break
        case 'OverconstrainedError':
        case 'ConstraintNotSatisfiedError':
          msg = '当前麦克风不支持 16kHz 单声道采样。请在系统设置中将麦克风设为默认设备。'
          break
        case 'AbortError':
          msg = '麦克风启动被中断，请重试。'
          break
        case 'SecurityError':
          msg = '麦克风访问被浏览器安全策略拦截。请使用 HTTPS 或 localhost 访问。'
          break
        default:
          msg = `无法访问麦克风: ${rawMsg}`
      }
      console.error('[ChatStream] getUserMedia 失败:', name, rawMsg)
      setError(msg)
      cbErrorRef.current?.(msg)
      teardown()
      try {
        ws.close()
      } catch {
        /* noop */
      }
      // ✅ mic 失败也要释放 busy，否则永远无法重新开始
      busyRef.current = false
    }
  }

  // 让 startConversation 立即返回（不 await ws.open / 不 await mic）
  // 这样 handleStart 不会被卡住，UI 能立即显示"正在录音"状态
  // ws 异步连接：ws.open 触发时再发 start 消息
  // mic 异步启动：mic 启动后开始采集 audio，onaudioprocess 在 ws.open 之前静默丢弃
  void startMicrophone(ws)
  // 不 await — 立刻返回，让 UI 立即响应
  }, [getWsBase, opts.language, opts.sessionId, teardown])

  // ============== 停止 ==============

  const stopConversation = useCallback(() => {
    try {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'stop' }))
      }
    } catch {
      /* noop */
    }
    // 立刻关闭麦克风（audio 帧不需要继续推了）
    teardown()
    // ✅ 释放 busy，让下一次 startConversation 可以再进入
    busyRef.current = false
  }, [teardown])

  // ============== 重置 ==============

  const reset = useCallback(() => {
    setInterimText('')
    setUserFinalText(null)
    setLlmText('')
    setError(null)
  }, [])

  // 卸载清理
  useEffect(() => {
    return () => {
      try {
        wsRef.current?.close()
      } catch {
        /* noop */
      }
      teardown()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 占位调用，保证函数引用被使用（避免 lint 误报）
  void axisAlignedMap

  return {
    isConnected,
    isRecording,
    isPipelineRunning,
    interimText,
    userFinalText,
    llmText,
    error,
    startConversation,
    stopConversation,
    reset,
  }
}