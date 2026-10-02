import { useCallback, useEffect, useRef } from 'react'
import {
  SimliClient,
  generateIceServers,
  LogLevel,
} from 'simli-client'
import { useChatStore } from '../store/chatStore'

interface UseAvatarReturn {
  initAvatar: (rtcParams: any) => Promise<void>
  startConversation: () => Promise<void>
  stopConversation: () => void
  pushAudioData: (audioData: ArrayBuffer, isEnd: boolean) => void
  /** 把后端 TTS 回来的 mp3 base64 解码 + 重采样成 PCM16/16kHz/mono，然后喂给数字人 */
  feedAvatarAudio: (mp3Base64: string) => Promise<void>
  interrupt: () => void
  setVolume: (volume: number) => void
  exitAvatar: () => void
  isReady: boolean
}

/**
 * Simli P2P 实时数字人
 *
 * 架构：
 *   1. 后端 /api/avatar/init 返回 Simli session_token + api_key + face_id
 *   2. 前端用 simli-client 的 SimliClient(token, videoEl, audioEl, iceServers, ..., "p2p")
 *   3. 浏览器直接与 Simli 云建立 WebRTC，无需 LiveKit SFU
 *   4. 音频数据：阶段 1 把后端 TTS 出来的 mp3 解码 + 重采样到 PCM16/16kHz/mono，再喂 Simli
 *
 * 文档: https://docs.simli.com/api-reference/javascript
 */
export const useAvatar = (): UseAvatarReturn => {
  const simliClientRef = useRef<SimliClient | null>(null)
  const isReadyRef = useRef(false)
  // 共享的 AudioContext（decodeAudioData 用；不能反复创建，否则浏览器会拒绝）
  const audioCtxRef = useRef<AudioContext | null>(null)

  const { setAvatarReady, setAvatarState, setError } = useChatStore()

  // ============== helpers ==============

  const getAudioCtx = useCallback((): AudioContext => {
    if (!audioCtxRef.current) {
      const Ctor = window.AudioContext || (window as any).webkitAudioContext
      audioCtxRef.current = new Ctor()
    }
    return audioCtxRef.current!
  }, [])

  /**
   * mp3/wav/pcm bytes (任意采样率/声道) → PCM16 / 16kHz / mono bytes
   * 使用 OfflineAudioContext 重采样（decodeAudioData 自身也能部分重采样，
   * 但 OfflineAudioContext 可以精确控制目标采样率和声道数）。
   */
  const decodeAndResampleTo16kMono = useCallback(
    async (inputBytes: ArrayBuffer): Promise<Int16Array> => {
      const ctx = getAudioCtx()

      // 必须先拷贝 ArrayBuffer，因为 decodeAudioData 会 transfer ownership
      const decoded = await ctx.decodeAudioData(inputBytes.slice(0))

      const TARGET_SR = 16000
      const offline = new OfflineAudioContext(
        1,
        Math.ceil(decoded.duration * TARGET_SR),
        TARGET_SR
      )
      const src = offline.createBufferSource()
      src.buffer = decoded
      src.connect(offline.destination)
      src.start(0)

      const rendered = await offline.startRendering()
      const float32 = rendered.getChannelData(0) // Float32Array, range [-1, 1]

      // Float32 → Int16 PCM (little-endian)
      const int16 = new Int16Array(float32.length)
      for (let i = 0; i < float32.length; i++) {
        const s = Math.max(-1, Math.min(1, float32[i]))
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff
      }
      return int16
    },
    [getAudioCtx]
  )

  /** Int16Array → Uint8Array (little-endian view, 适合 WebTransport) */
  const int16ToUint8 = (i16: Int16Array): Uint8Array => {
    return new Uint8Array(i16.buffer, i16.byteOffset, i16.byteLength)
  }

  // ============== actions ==============

  const initAvatar = useCallback(
    async (rtcParams: any) => {
      try {
        console.log('[useAvatar] 初始化 Simli P2P:', rtcParams)

        const apiKey = rtcParams?.api_key as string | undefined
        const faceId = rtcParams?.face_id as string | undefined
        const sessionToken = rtcParams?.session_token as string | undefined
        if (!apiKey || !faceId || !sessionToken) {
          throw new Error(
            'Simli P2P 凭证缺失（api_key / face_id / session_token）。请检查后端 /avatar/init 返回值'
          )
        }

        // ✅ 关键修复：DOM 可能还没渲染（极端 race），最多等 1.5s（每 50ms 重试一次）
        // 同时诊断：列出 #cloudAvatarContainer 存在与否 + 同 id 的元素数量
        let videoEl: HTMLVideoElement | null = null
        for (let i = 0; i < 30; i++) {
          videoEl = document.getElementById(
            'cloudAvatarContainer'
          ) as HTMLVideoElement | null
          if (videoEl) break
          if (i === 0) {
            console.warn(
              `[useAvatar] 第 1 次没找到 video。诊断: document.readyState=${document.readyState}, ` +
                `body.children.length=${document.body.children.length}, ` +
                `cloudAvatarContainer count=${document.querySelectorAll('#cloudAvatarContainer').length}`
            )
          }
          await new Promise((r) => setTimeout(r, 50))
        }
        if (!videoEl) {
          throw new Error(
            '找不到 #cloudAvatarContainer video 元素（已等待 1.5s）。请确认当前页面是主对话界面（不是设置页）'
          )
        }
        const audioEl = document.getElementById('cloudAvatarAudio') as HTMLAudioElement | null
        const audioElReal: HTMLAudioElement =
          audioEl ||
          (() => {
            const el = document.createElement('audio')
            el.autoplay = true
            el.id = 'cloudAvatarAudio'
            document.body.appendChild(el)
            return el
          })()

        console.log('[useAvatar] 获取 ICE servers...')
        const iceServers = await generateIceServers(apiKey)
        console.log('[useAvatar] ICE servers:', iceServers)

        const client = new SimliClient(
          sessionToken,
          videoEl,
          audioElReal,
          iceServers,
          LogLevel.INFO,
          'p2p'
        )
        simliClientRef.current = client

        client.on('start', () => {
          console.log('[useAvatar] Simli 已连接，数字人开始展示')
          setAvatarReady(true)
          isReadyRef.current = true
          setAvatarState('idle')
        })

        client.on('speaking', () => {
          console.log('[useAvatar] 数字人开始说话')
          setAvatarState('speaking')
        })

        client.on('silent', () => {
          console.log('[useAvatar] 数字人停止说话')
          setAvatarState('idle')
        })

        client.on('stop', () => {
          console.log('[useAvatar] Simli 连接断开（服务端）')
          setAvatarReady(false)
          isReadyRef.current = false
        })

        client.on('error', (msg: string) => {
          console.error('[useAvatar] Simli error:', msg)
        })

        client.on('startup_error', (msg: string) => {
          console.error('[useAvatar] Simli startup_error:', msg)
          setError(`Simli 启动失败: ${msg}`)
          isReadyRef.current = false
        })

        console.log('[useAvatar] SimliClient.start() ...')
        await client.start()
        console.log('[useAvatar] SimliClient.start() 完成')
      } catch (error: any) {
        console.error('[useAvatar] 初始化数字人失败:', error)
        setError(`初始化失败: ${error?.message || String(error)}`)
        throw error
      }
    },
    [setAvatarReady, setAvatarState, setError]
  )

  const startConversation = useCallback(async () => {
    console.log('[useAvatar] startConversation: 由 App 层调 feedAvatarAudio()')
  }, [])

  const stopConversation = useCallback(() => {
    const client = simliClientRef.current
    if (!client) return
    try {
      client.ClearBuffer()
      console.log('[useAvatar] 已停止当前发言')
    } catch (e) {
      console.warn('[useAvatar] ClearBuffer 异常:', e)
    }
  }, [])

  const pushAudioData = useCallback((audioData: ArrayBuffer, _isEnd: boolean = true) => {
    const client = simliClientRef.current
    if (!client) {
      console.warn('[useAvatar] pushAudioData: SimliClient 未就绪，丢弃音频')
      return
    }
    client.sendAudioData(new Uint8Array(audioData))
  }, [])

  /**
   * 阶段 1 关键函数：把后端 TTS 出来的 mp3/wav base64 喂给数字人
   *
   * 流程：base64 → ArrayBuffer → decodeAudioData → OfflineAudioContext(16k/mono)
   *       → Int16 PCM → 按 6000 字节分块 → simliClient.sendAudioData
   *
   * 注意：音频是顺序消费，不需要一次性喂完，可以 sleep 等 Simli 处理完上一块再发下一块。
   */
  const feedAvatarAudio = useCallback(
    async (mp3Base64: string) => {
      const client = simliClientRef.current
      if (!client) {
        console.warn('[useAvatar] feedAvatarAudio: SimliClient 未创建，跳过')
        return
      }
      if (!isReadyRef.current) {
        console.warn('[useAvatar] feedAvatarAudio: 数字人未就绪（isReady=false），跳过')
        return
      }
      try {
        console.log(`[useAvatar] feedAvatarAudio 收到 ${mp3Base64.length} 字符 base64`)

        // 1) base64 → ArrayBuffer
        const binaryStr = atob(mp3Base64)
        const bytes = new Uint8Array(binaryStr.length)
        for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i)
        const arrayBuffer = bytes.buffer
        console.log(`[useAvatar] 解码出 ${bytes.length} bytes (MP3)`)

        // 2) decode + 重采样 → PCM16/16k/mono
        const int16 = await decodeAndResampleTo16kMono(arrayBuffer)
        console.log(
          `[useAvatar] 重采样: ${int16.length} samples = ${(int16.length / 16000).toFixed(2)}s @ 16kHz`
        )
        if (int16.length === 0) {
          console.warn('[useAvatar] 重采样结果为空，跳过')
          return
        }

        // 3) 分块 6000 bytes (Simli 推荐) → sendAudioData
        const CHUNK_BYTES = 6000
        const fullBytes = int16ToUint8(int16)
        let offset = 0
        let chunkIdx = 0
        while (offset < fullBytes.length) {
          const end = Math.min(offset + CHUNK_BYTES, fullBytes.length)
          const chunk = fullBytes.slice(offset, end)
          client.sendAudioData(chunk)
          chunkIdx++
          offset = end

          // 每 ~50ms 一块（6000 bytes / 16000Hz = 375ms 音频）— 给 Simli 处理时间
          if (offset < fullBytes.length) {
            await new Promise((r) => setTimeout(r, 50))
          }
        }
        console.log(`[useAvatar] feedAvatarAudio 完成，共 ${chunkIdx} 块`)
      } catch (e: any) {
        console.error('[useAvatar] feedAvatarAudio 失败:', e)
        setError(`数字人播放失败: ${e?.message || String(e)}`)
      }
    },
    [decodeAndResampleTo16kMono, setError]
  )

  const interrupt = useCallback(() => {
    const client = simliClientRef.current
    if (!client) return
    try {
      client.ClearBuffer()
    } catch (e) {
      console.warn('[useAvatar] interrupt 异常:', e)
    }
  }, [])

  const setVolume = useCallback((_volume: number) => {
    const audioEl = document.getElementById('cloudAvatarAudio') as HTMLAudioElement | null
    if (audioEl) {
      audioEl.volume = Math.max(0, Math.min(1, _volume))
    }
  }, [])

  const exitAvatar = useCallback(() => {
    const client = simliClientRef.current
    if (client) {
      try {
        client.stop()
      } catch (e) {
        console.error('[useAvatar] Simli.stop 异常:', e)
      }
    }
    simliClientRef.current = null
    setAvatarReady(false)
    isReadyRef.current = false
  }, [setAvatarReady])

  // 卸载清理
  useEffect(() => {
    return () => {
      const client = simliClientRef.current
      if (client) {
        try {
          client.stop()
        } catch (e) {
          console.error('[useAvatar] cleanup stop 异常:', e)
        }
        simliClientRef.current = null
      }
      if (audioCtxRef.current) {
        try {
          audioCtxRef.current.close()
        } catch {
          /* ignore */
        }
        audioCtxRef.current = null
      }
    }
  }, [])

  return {
    initAvatar,
    startConversation,
    stopConversation,
    pushAudioData,
    feedAvatarAudio,
    interrupt,
    setVolume,
    exitAvatar,
    isReady: isReadyRef.current,
  }
}
