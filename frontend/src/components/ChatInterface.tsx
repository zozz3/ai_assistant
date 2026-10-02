import React, { useEffect, useRef, useState } from 'react'
import { useChatStore, type Message, SCENE_LABELS } from '../store/chatStore'

/** 兜底：如果 assistant.content 里有遗留的 <grammar>...</grammar> 标签，UI 渲染时直接去掉 */
function stripGrammarBlock(text: string): string {
  if (!text) return ''
  return text.replace(/<grammar>[\s\S]*?<\/grammar>/gi, '').trim()
}

interface ChatInterfaceProps {
  /**
   * 点击 🔊 重读按钮：TTS → 数字人播放
   */
  onRepeatSpeak?: (text: string, messageId: string) => void | Promise<void>
}

/**
 * 微信式聊天框：
 * - 消息完整显示，不折叠
 * - 固定大小（父容器 flex-1 + min-h-0 + overflow-hidden），溢出滚动
 * - AI 消息内嵌 ▶ TTS 音频播放器
 */
export const ChatInterface: React.FC<ChatInterfaceProps> = ({ onRepeatSpeak }) => {
  const { messages, activeScene, generatingMessageId } = useChatStore()
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)

  // 新消息 → 平滑滚动到底部
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, generatingMessageId])

  // 重读按钮 loading 状态
  const [speakingId, setSpeakingId] = useState<string | null>(null)
  const handleRepeatSpeak = async (msg: Message) => {
    if (!msg.content) return
    setSpeakingId(msg.id)
    try {
      await onRepeatSpeak?.(msg.content, msg.id)
    } catch (e) {
      console.error('[ChatInterface] 重读失败:', e)
    } finally {
      setTimeout(() => setSpeakingId((cur) => (cur === msg.id ? null : cur)), 1500)
    }
  }

  const formatTime = (ts: any) => {
    if (!ts) return ''
    const d = ts instanceof Date ? ts : new Date(ts)
    if (isNaN(d.getTime())) return ''
    try {
      return new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit' }).format(d)
    } catch {
      return ''
    }
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* 固定消息气泡区 — 加 chat-scroll 类名启用自定义滚动条样式 */}
      <div
        ref={scrollContainerRef}
        className="chat-scroll flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-2"
        style={{
          scrollBehavior: 'smooth',
          background: '#f8fafc',
          borderRadius: '12px',
        }}
      >
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-gray-400 select-none">
            <div className="text-5xl mb-3">🗣️</div>
            <p className="text-base font-medium">Start practicing English!</p>
            <p className="text-xs mt-1">点击麦克风按钮开始对话</p>
            <p className="text-xs mt-2 text-blue-400">切换「日常英语」或「面试英语」场景 ↑</p>
          </div>
        ) : (
          <>
            {messages.map((msg, idx) => (
              <MessageBubble
                key={msg.id}
                message={msg}
                idx={idx}
                activeSceneLabel={
                  idx === 0 && msg.role === 'assistant' && activeScene
                    ? SCENE_LABELS[activeScene as keyof typeof SCENE_LABELS] ?? activeScene
                    : null
                }
                isGenerating={msg.id === generatingMessageId}
                speakingId={speakingId}
                onRepeatSpeak={handleRepeatSpeak}
                formatTime={formatTime}
              />
            ))}
            <div ref={messagesEndRef} />
          </>
        )}
      </div>
    </div>
  )
}

/* ================================================================
   单个消息气泡：完整显示，无折叠
   ================================================================ */
interface MessageBubbleProps {
  message: Message
  idx: number
  activeSceneLabel: string | null
  isGenerating: boolean
  speakingId: string | null
  onRepeatSpeak: (msg: Message) => void
  formatTime: (ts: any) => string
}

function MessageBubble({
  message,
  idx: _idx,
  activeSceneLabel,
  isGenerating,
  speakingId,
  onRepeatSpeak,
  formatTime,
}: MessageBubbleProps) {
  const isUser = message.role === 'user'
  const isSpeaking = speakingId === message.id
  const hasAudio = !isUser && !!message.audioUrl

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} message-bubble`}>
      <div
        className={`group relative max-w-[78%] rounded-2xl px-4 py-2.5 shadow-sm transition-all ${
          isUser
            ? 'bg-gradient-to-r from-blue-500 to-blue-600 text-white rounded-br-sm'
            : 'bg-white text-gray-800 rounded-bl-sm border border-gray-100'
        } ${isGenerating ? 'ring-2 ring-blue-300' : ''}`}
      >
        {activeSceneLabel && (
          <div className="text-[10px] text-blue-400 font-medium mb-1">{activeSceneLabel}</div>
        )}

        {/* 完整文本（不折叠） — 兜底去掉 <grammar> 块（即使 onPipelineDone 没 strip） */}
        <p className="text-sm leading-relaxed whitespace-pre-wrap break-words">
          {stripGrammarBlock(message.content) || (isGenerating ? '💭 AI 正在思考…' : '')}
        </p>

        {/* ✅ User 消息：语法纠错卡（仅 interview 场景 + LLM 检测到错误时） */}
        {isUser && message.grammarCheck && message.grammarCheck.length > 0 && (
          <GrammarCheckCard checks={message.grammarCheck} />
        )}

        {/* AI 消息：内嵌 TTS 音频播放器（自动展开，不点击） */}
        {!isUser && (
          <div className="mt-2">
            {hasAudio ? (
              <AudioPlayer
                key={message.id + (message.audioUrl?.length || 0)}
                audioUrl={message.audioUrl!}
                messageId={message.id}
              />
            ) : isGenerating ? (
              <div className="text-[11px] text-gray-400 italic">🔊 音频合成中…</div>
            ) : null}
          </div>
        )}

        {/* 底部操作行：时间 + 🔊 重读 */}
        <div className={`flex items-center gap-2 mt-1 ${isUser ? 'justify-end' : 'justify-between'}`}>
          <p className={`text-[10px] ${isUser ? 'text-blue-100' : 'text-gray-400'}`}>
            {formatTime(message.timestamp)}
          </p>
          {!isUser && message.content && (
            <button
              onClick={() => onRepeatSpeak(message)}
              disabled={isSpeaking}
              title={isSpeaking ? '正在合成…' : '让数字人重读'}
              className="text-[11px] text-blue-500 hover:bg-blue-50 px-1.5 py-0.5 rounded transition-colors disabled:opacity-50"
              style={{ opacity: isSpeaking ? 1 : 0.7 }}
            >
              {isSpeaking ? '🔊 …' : '🔊'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/* ================================================================
   AudioPlayer：mp3 base64 → 原生 <audio> 播放
   ================================================================ */
interface AudioPlayerProps {
  audioUrl: string
  messageId: string
}

function AudioPlayer({ audioUrl, messageId }: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [duration, setDuration] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)

  useEffect(() => {
    const a = audioRef.current
    if (!a) return
    const onPlay = () => setIsPlaying(true)
    const onPause = () => setIsPlaying(false)
    const onEnded = () => {
      setIsPlaying(false)
      setCurrentTime(0)
    }
    const onTime = () => setCurrentTime(a.currentTime)
    const onLoaded = () => setDuration(a.duration || 0)
    a.addEventListener('play', onPlay)
    a.addEventListener('pause', onPause)
    a.addEventListener('ended', onEnded)
    a.addEventListener('timeupdate', onTime)
    a.addEventListener('loadedmetadata', onLoaded)
    return () => {
      a.removeEventListener('play', onPlay)
      a.removeEventListener('pause', onPause)
      a.removeEventListener('ended', onEnded)
      a.removeEventListener('timeupdate', onTime)
      a.removeEventListener('loadedmetadata', onLoaded)
    }
  }, [messageId])

  const fmt = (s: number) => {
    if (!isFinite(s) || s < 0) return '0:00'
    const m = Math.floor(s / 60)
    const sec = Math.floor(s % 60)
    return `${m}:${sec.toString().padStart(2, '0')}`
  }

  return (
    <div className="bg-gradient-to-r from-blue-50 to-purple-50 rounded-lg p-2 border border-blue-100">
      <div className="flex items-center gap-2">
        <button
          onClick={() => {
            const a = audioRef.current
            if (!a) return
            if (isPlaying) a.pause()
            else a.play()
          }}
          className="w-8 h-8 flex-shrink-0 rounded-full bg-blue-500 hover:bg-blue-600 text-white flex items-center justify-center text-sm transition-colors shadow-sm"
          title={isPlaying ? '暂停' : '播放'}
        >
          {isPlaying ? '⏸' : '▶'}
        </button>
        <div className="flex-1 min-w-0">
          <input
            type="range"
            min={0}
            max={duration || 0}
            step={0.1}
            value={currentTime}
            onChange={(e) => {
              const a = audioRef.current
              if (a) a.currentTime = Number(e.target.value)
            }}
            className="w-full h-1 appearance-none bg-blue-200 rounded-full cursor-pointer"
            style={{ accentColor: '#3b82f6' }}
            aria-label="播放进度"
          />
          <div className="flex items-center justify-between text-[10px] text-gray-500 mt-0.5">
            <span>{fmt(currentTime)}</span>
            <span>🎵 TTS · 本地缓存</span>
            <span>{fmt(duration)}</span>
          </div>
        </div>
      </div>
      <audio ref={audioRef} src={audioUrl} preload="metadata" />
    </div>
  )
}

/* ================================================================
   GrammarCheckCard：面试模式下的语法纠错卡
   显示原文 → 修正 → 简短解释
   ================================================================ */
interface GrammarCheckCardProps {
  checks: Array<{ original: string; corrected: string; explanation: string }>
}

const GrammarCheckCard: React.FC<GrammarCheckCardProps> = ({ checks }) => {
  if (!checks || checks.length === 0) return null
  return (
    <div className="mt-2 rounded-lg border border-amber-300 bg-amber-50 overflow-hidden">
      <div className="px-2.5 py-1.5 bg-amber-100/70 border-b border-amber-200 flex items-center gap-1.5">
        <span className="text-xs">📝</span>
        <span className="text-[11px] font-semibold text-amber-800">
          Grammar Tips ({checks.length})
        </span>
      </div>
      <ul className="divide-y divide-amber-200/60">
        {checks.map((c, i) => (
          <li key={i} className="px-2.5 py-1.5 text-[12px]">
            <div className="flex items-baseline gap-1.5 flex-wrap">
              <span className="line-through text-red-600/80">{c.original}</span>
              <span className="text-amber-700">→</span>
              <span className="font-semibold text-green-700">{c.corrected}</span>
            </div>
            {c.explanation && (
              <div className="text-[11px] text-amber-800/80 mt-0.5 leading-snug">
                💡 {c.explanation}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}