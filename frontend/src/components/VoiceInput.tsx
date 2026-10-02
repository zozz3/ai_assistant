import React, { useCallback, useRef, useState } from 'react'

interface VoiceInputProps {
  /** 按下按钮触发（开始录音 + 启动流式对话管道） */
  onStart: () => Promise<void> | void
  /** 松开按钮触发（停止录音，触发 ASR 收尾 + LLM + TTS） */
  onStop: () => void
  /** 错误透传 */
  onError?: (error: string) => void
  /** 实时 ASR 临时文本 */
  interimText?: string
  /** 实时 LLM 流式文本 */
  llmText?: string
  /** 数字人状态（用于按钮颜色/动画） */
  avatarState?: 'idle' | 'listening' | 'thinking' | 'speaking'
  disabled?: boolean
}

/**
 * 流式对话麦克风控制组件（tap-to-talk）
 *
 * 流程：
 *   按下 → onStart()  → useChatStream 连 ws + 启动麦克风 + 发 audio 帧
 *   松开 → onStop()   → useChatStream 发 stop → ASR 收尾 → LLM → TTS → 数字人
 *
 * 注意：本组件不再持有 useAudioRecorder / useSpeechRecognition，
 * 麦克风采集 + ASR 全在 useChatStream 内部完成，避免重复打开麦克风。
 */
export const VoiceInput: React.FC<VoiceInputProps> = ({
  onStart,
  onStop,
  onError,
  interimText,
  llmText,
  avatarState,
  disabled = false,
}) => {
  const [isPressing, setIsPressing] = useState(false)
  const [isStarting, setIsStarting] = useState(false)
  // 用 ref 跟踪最新的 onStart/onStop，避免 click 事件触发的 stale closure
  const onStartRef = useRef(onStart)
  const onStopRef = useRef(onStop)
  onStartRef.current = onStart
  onStopRef.current = onStop

  const toggle = useCallback(async () => {
    if (disabled || isStarting) return
    // 直接从 avatarState 算 isAiBusy，避免与下面声明顺序冲突
    const aiBusy = avatarState === 'thinking' || avatarState === 'speaking'
    if (aiBusy) {
      onError?.(avatarState === 'thinking' ? 'AI 正在思考，请稍候' : 'AI 正在回答，请听完再说话')
      return
    }
    if (isPressing) {
      // 正在录音 → 停止
      setIsPressing(false)
      try {
        onStopRef.current()
      } catch (e: any) {
        onError?.(e?.message || String(e))
      }
    } else {
      // 未录音 → 开始
      setIsStarting(true)
      try {
        await onStartRef.current()
        setIsPressing(true)
      } catch (e: any) {
        onError?.(e?.message || String(e))
      } finally {
        setIsStarting(false)
      }
    }
  }, [disabled, isStarting, avatarState, isPressing, onError])

  const isUserRecording = isPressing           // 用户视角：是否正在自己录音
  const isThinking = avatarState === 'thinking'
  const isSpeaking = avatarState === 'speaking'

  // ✅ 严格一问一答：AI 思考/说话期间禁用麦克风按钮，避免上一轮回答被打断或音频帧错乱。
  // 按钮会变灰并显示「请等待 AI 说完…」；pipeline_done 后由父组件把 avatarState 切回 idle
  // 才允许下一次录音。
  const isAiBusy = isThinking || isSpeaking
  const isButtonDisabled = disabled || isStarting || isAiBusy

  // 按钮颜色基于状态：
  //   - 用户录音中  → 红
  //   - AI 思考中   → 黄
  //   - AI 回答中   → 紫
  //   - 待机        → 蓝紫渐变
  //   - 禁用        → 灰
  const buttonColor = isUserRecording
    ? 'bg-red-500 hover:bg-red-600 animate-pulse'
    : isAiBusy
      ? 'bg-gray-400 cursor-not-allowed'
      : 'bg-gradient-to-r from-blue-500 to-purple-500 hover:from-blue-600 hover:to-purple-600'

  // 顶部状态条文字（给用户清晰的"当前轮到谁说话"提示）
  const statusText = isButtonDisabled && !disabled && !isStarting
    ? (isThinking ? '🤔 AI 正在思考… 请稍候' : '🗣️ AI 正在回答… 请听完再说话')
    : disabled
      ? '请先初始化数字人'
      : isUserRecording
        ? '🎙️ 正在聆听… 再点一次结束本轮'
        : '🎤 点击麦克风开始本轮对话'

  return (
    <div className="flex flex-col items-center space-y-4 select-none">
      {/* 实时反馈：用户临时文本 + AI 流式文本 */}
      {(interimText || llmText) && (
        <div className="w-full max-w-md p-4 bg-white rounded-lg shadow space-y-2">
          {interimText && (
            <div>
              <span className="text-xs text-gray-400">🎤 正在听：</span>
              <p className="text-gray-400 italic">{interimText}</p>
            </div>
          )}
          {llmText && (
            <div>
              <span className="text-xs text-gray-400">🤖 AI 正在说：</span>
              <p className="text-gray-800">{llmText}</p>
            </div>
          )}
        </div>
      )}

      {/* 麦克风按钮（单击切换：点一下开始，再点一下结束） */}
      <button
        onClick={toggle}
        disabled={isButtonDisabled}
        className={`
          relative w-20 h-20 rounded-full transition-all duration-200
          ${buttonColor}
          disabled:opacity-50 disabled:cursor-not-allowed
          shadow-lg hover:shadow-xl transform active:scale-95
          flex items-center justify-center
          cursor-pointer
        `}
        title={statusText}
      >
        {isUserRecording ? (
          // 录音中（方形 = 停止提示）
          <svg className="w-8 h-8 text-white" fill="currentColor" viewBox="0 0 24 24">
            <rect x="6" y="6" width="12" height="12" rx="2" />
          </svg>
        ) : (
          // 麦克风图标（默认状态）
          <svg className="w-8 h-8 text-white" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V5z" />
            <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
          </svg>
        )}
        {isUserRecording && (
          <span className="absolute inset-0 rounded-full border-4 border-red-400 animate-ping" />
        )}
      </button>

      {/* 提示文本 */}
      <p className="text-sm text-gray-600 text-center">
        {statusText}
      </p>
    </div>
  )
}