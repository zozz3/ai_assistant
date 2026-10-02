import { useCallback, useEffect, useRef, useState } from 'react'

export type ASREngine = 'browser' | 'dashscope-stream'

interface UseSpeechRecognitionReturn {
  transcript: string
  interimTranscript: string
  sentences: string[]
  isListening: boolean
  isConnecting: boolean
  startListening: () => Promise<void>
  stopListening: () => void
  resetTranscript: () => void
  isSupported: boolean
  error: string | null
  engine: ASREngine
  metrics: {
    request_id?: string | null
    first_package_delay_ms?: number | null
    last_package_delay_ms?: number | null
    sentence_count?: number
  }
}

/**
 * 语音识别 Hook（统一封装浏览器 WebSpeech 与阿里云 DashScope 流式 ASR）
 *
 * engine = 'browser'           → 使用浏览器自带的 SpeechRecognition API
 * engine = 'dashscope-stream'  → 通过后端 WebSocket /api/asr/stream 走阿里云 qwen-audio 流式 ASR
 *
 * 使用方式：
 *   const { startListening, stopListening, transcript, sentences, ... } = useSpeechRecognition({
 *     engine: 'dashscope-stream',
 *     language: 'en',
 *     onResult: (text) => ...,
 *   })
 */
interface UseSpeechRecognitionOptions {
  engine?: ASREngine
  language?: string
  sampleRate?: number
  sessionId?: string
  onResult?: (finalText: string, sentences: string[]) => void
  onError?: (message: string) => void
  wsBaseUrl?: string  // 默认从 import.meta.env.VITE_WS_BASE_URL 或当前 host
  workspaceId?: string
}

export const useSpeechRecognition = (
  optsOrCallback?:
    | UseSpeechRecognitionOptions
    | ((transcript: string) => void)
    | ((text: string, sentences: string[]) => void),
  legacyOnError?: (error: string) => void
): UseSpeechRecognitionReturn => {
  // 兼容旧式签名 useSpeechRecognition(onResult?, onError?)
  const opts: UseSpeechRecognitionOptions = (() => {
    if (typeof optsOrCallback === 'function') {
      return {
        engine: 'browser',
        onResult: optsOrCallback as (text: string) => void,
        onError: legacyOnError,
      }
    }
    return { engine: 'browser', ...(optsOrCallback || {}) }
  })()

  const engine = opts.engine || 'browser'

  // ========== 浏览器 WebSpeech 分支 ==========
  const [transcript, setTranscript] = useState('')
  const [interimTranscript, setInterimTranscript] = useState('')
  const [isListening, setIsListening] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isBrowserSupported =
    typeof window !== 'undefined' && ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)

  const recognitionRef = useRef<any>(null)
  const finalTranscriptRef = useRef('')

  useEffect(() => {
    if (engine === 'dashscope-stream') return  // 流式分支单独管理
    if (!isBrowserSupported) {
      setError('当前浏览器不支持语音识别')
      return
    }
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    const r = new SpeechRecognition()
    r.continuous = false
    r.interimResults = true
    r.lang = opts.language === 'zh' ? 'zh-CN' : 'en-US'
    recognitionRef.current = r

    r.onstart = () => {
      setIsListening(true)
      setError(null)
      finalTranscriptRef.current = ''
    }
    r.onresult = (event: any) => {
      let finalText = ''
      let interim = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const piece = event.results[i][0].transcript
        if (event.results[i].isFinal) finalText += piece
        else interim += piece
      }
      if (finalText) finalTranscriptRef.current += finalText
      setTranscript(finalTranscriptRef.current)
      setInterimTranscript(interim)
    }
    r.onerror = (event: any) => {
      const msg =
        event.error === 'no-speech'
          ? '没有检测到语音，请重试'
          : event.error === 'not-allowed'
            ? '麦克风访问被拒绝'
            : `语音识别错误: ${event.error}`
      setError(msg)
      setIsListening(false)
      opts.onError?.(msg)
    }
    r.onend = () => {
      setIsListening(false)
      if (finalTranscriptRef.current && opts.onResult) {
        opts.onResult(finalTranscriptRef.current, [finalTranscriptRef.current])
      }
    }

    return () => {
      try {
        r.abort()
      } catch (e) {
        /* noop */
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, isBrowserSupported, opts.language])

  const startBrowser = useCallback((): Promise<void> => {
    if (recognitionRef.current && !isListening) {
      try {
        recognitionRef.current.start()
      } catch (err) {
        console.error('启动语音识别失败:', err)
      }
    }
    return Promise.resolve()
  }, [isListening])

  const stopBrowser = useCallback(() => {
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop()
      } catch (e) {
        /* noop */
      }
      setIsListening(false)
    }
  }, [])

  // ========== DashScope 流式分支 ==========
  const wsRef = useRef<WebSocket | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const [isConnecting, setIsConnecting] = useState(false)
  const [sentences, setSentences] = useState<string[]>([])
  const [metrics, setMetrics] = useState<UseSpeechRecognitionReturn['metrics']>({})

  const stopDashScope = useCallback(() => {
    try {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'stop' }))
      }
    } catch (e) {
      /* noop */
    }
    try {
      processorRef.current?.disconnect()
    } catch (e) {
      /* noop */
    }
    try {
      mediaStreamRef.current?.getTracks().forEach((t) => t.stop())
    } catch (e) {
      /* noop */
    }
    try {
      audioCtxRef.current?.close()
    } catch (e) {
      /* noop */
    }
    processorRef.current = null
    mediaStreamRef.current = null
    audioCtxRef.current = null
    wsRef.current = null
    setIsListening(false)
  }, [])

  const startDashScope = useCallback(async () => {
    if (isListening || isConnecting) return
    setIsConnecting(true)
    setError(null)
    setSentences([])
    setMetrics({})
    finalTranscriptRef.current = ''
    setTranscript('')
    setInterimTranscript('')

    // 1) 打开 WebSocket
    const wsBase =
      opts.wsBaseUrl ||
      (import.meta.env.VITE_WS_BASE_URL as string | undefined) ||
      (window.location.protocol === 'https:' ? 'wss' : 'ws') +
        '://' +
        window.location.host + '/api/asr/stream'

    const ws = new WebSocket(wsBase)
    wsRef.current = ws

    ws.onopen = () => {
      setIsConnecting(false)
      // 2) 启动会话
      ws.send(
        JSON.stringify({
          type: 'start',
          session_id: opts.sessionId || `asr_${Date.now()}`,
          language: opts.language || 'en',
          format: 'pcm',
          sample_rate: opts.sampleRate || 16000,
          workspace_id: opts.workspaceId || undefined,
          streaming_model: 'qwen-audio-3.0-asr-flash-streaming',
        })
      )
      setIsListening(true)
    }

    ws.onmessage = async (ev) => {
      try {
        const msg = JSON.parse(ev.data)
        if (msg.type === 'open') {
          // 3) 启动麦克风采集
          try {
            const stream = await navigator.mediaDevices.getUserMedia({
              audio: {
                sampleRate: opts.sampleRate || 16000,
                channelCount: 1,
                echoCancellation: true,
                noiseSuppression: true,
              },
            })
            mediaStreamRef.current = stream
            const AudioCtx = (window as any).AudioContext || (window as any).webkitAudioContext
            const ctx = new AudioCtx({ sampleRate: opts.sampleRate || 16000 })
            audioCtxRef.current = ctx
            const source = ctx.createMediaStreamSource(stream)
            const bufferSize = 4096
            const processor = ctx.createScriptProcessor(bufferSize, 1, 1)
            processorRef.current = processor
            source.connect(processor)
            processor.connect(ctx.destination)
            processor.onaudioprocess = (e: AudioProcessingEvent) => {
              if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return
              const input = e.inputBuffer.getChannelData(0)
              // 转 Int16 PCM
              const pcm = new Int16Array(input.length)
              for (let i = 0; i < input.length; i++) {
                const s = Math.max(-1, Math.min(1, input[i]))
                pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff
              }
              // 转 base64
              const bytes = new Uint8Array(pcm.buffer)
              let binary = ''
              for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i])
              const b64 = btoa(binary)
              wsRef.current.send(JSON.stringify({ type: 'audio', data: b64 }))
            }
          } catch (micErr: any) {
            const msg = `无法访问麦克风: ${micErr?.message || micErr}`
            setError(msg)
            opts.onError?.(msg)
            stopDashScope()
          }
        } else if (msg.type === 'partial') {
          setInterimTranscript(msg.text)
        } else if (msg.type === 'sentence_end') {
          setSentences((prev) => {
            const next = [...prev, msg.text]
            setTranscript(next.join(' '))
            return next
          })
        } else if (msg.type === 'complete') {
          setMetrics(msg.metrics || {})
          const full = msg.text || sentencesRef.current.join(' ')
          setTranscript(full)
          if (full && opts.onResult) {
            opts.onResult(full, sentencesRef.current)
          }
          stopDashScope()
        } else if (msg.type === 'error') {
          setError(msg.message)
          opts.onError?.(msg.message)
        }
      } catch (e) {
        /* ignore */
      }
    }

    ws.onerror = () => {
      const errMsg = 'WebSocket 连接失败，请确认后端已启动且 /api/asr/stream 可达'
      setError(errMsg)
      opts.onError?.(errMsg)
      setIsConnecting(false)
      setIsListening(false)
    }
    ws.onclose = () => {
      setIsListening(false)
    }
  }, [opts.language, opts.sampleRate, opts.sessionId, opts.workspaceId, opts.wsBaseUrl, opts.onResult, opts.onError, isListening, isConnecting, stopDashScope])

  // 让 sentence_end 回调能拿到最新值（避免闭包过期）
  const sentencesRef = useRef<string[]>([])
  useEffect(() => {
    sentencesRef.current = sentences
  }, [sentences])

  const resetTranscript = useCallback(() => {
    setTranscript('')
    setInterimTranscript('')
    setSentences([])
  }, [])

  useEffect(() => {
    return () => {
      stopDashScope()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (engine === 'dashscope-stream') {
    return {
      transcript,
      interimTranscript,
      sentences,
      isListening,
      isConnecting,
      startListening: startDashScope,
      stopListening: stopDashScope,
      resetTranscript,
      isSupported: typeof window !== 'undefined' && 'WebSocket' in window,
      error,
      engine,
      metrics,
    }
  }

  return {
    transcript,
    interimTranscript,
    sentences: [],
    isListening,
    isConnecting: false,
    startListening: startBrowser,
    stopListening: stopBrowser,
    resetTranscript,
    isSupported: isBrowserSupported,
    error,
    engine: 'browser',
    metrics: {},
  }
}
