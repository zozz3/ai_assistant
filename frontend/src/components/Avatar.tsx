import React from 'react'

interface AvatarProps {
  className?: string
  isActive?: boolean
  state?: 'idle' | 'listening' | 'thinking' | 'speaking'
}

/**
 * 数字人渲染组件
 *
 * 后端方案: Simli P2P (浏览器 <-> Simli 云 WebRTC 直连，无 LiveKit)
 * 视频流通过 simli-client 订阅，挂载到 id="cloudAvatarContainer" 的 <video>
 * 音频流挂载到 id="cloudAvatarAudio" 的 <audio>
 */
export const Avatar: React.FC<AvatarProps> = ({
  className = '',
  isActive = false,
  state = 'idle',
}) => {
  const getStateMessage = () => {
    switch (state) {
      case 'listening':
        return '正在聆听...'
      case 'thinking':
        return '思考中...'
      case 'speaking':
        return '数字人正在播报...'
      default:
        return isActive ? 'Simli 数字人已就绪' : '点击下方"初始化数字人"开始'
    }
  }

  return (
    <div className={`relative ${className}`}>
      {/* 数字人视频容器 */}
      <div className="relative w-full h-full bg-gradient-to-br from-purple-900 to-indigo-900 rounded-2xl overflow-hidden shadow-2xl">
        {/* 视频元素 — Simli 视频流会挂到这里 */}
        <video
          id="cloudAvatarContainer"
          autoPlay
          playsInline
          muted
          className="w-full h-full object-cover"
          style={{ backgroundColor: '#1a1a2e' }}
        />
        {/* 音频元素 — Simli 音频流会挂到这里（autoPlay 由 useAvatar 注入） */}
        <audio id="cloudAvatarAudio" autoPlay style={{ display: 'none' }} />

        {/* 没视频流时显示占位 */}
        {!isActive && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-gradient-to-t from-black/50 via-transparent to-transparent">
            <div className="relative w-32 h-32 mb-4">
              <div className="absolute inset-0 rounded-full bg-gradient-to-br from-pink-400 to-purple-500 opacity-80">
                <div className="w-full h-full flex items-center justify-center text-6xl">
                  🎭
                </div>
              </div>
            </div>
            <div className="text-white/80 text-sm font-medium px-4 py-2 rounded-full bg-black/30 backdrop-blur-sm">
              {getStateMessage()}
            </div>
            <div className="mt-3 text-white/50 text-xs px-3 py-1 rounded bg-black/20">
              方案: Simli P2P (WebRTC)
            </div>
          </div>
        )}

        {/* 已连接时显示状态徽章 */}
        {isActive && (
          <div className="absolute top-4 left-4 flex items-center gap-2">
            <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse" />
            <span className="text-xs text-white/80 bg-black/40 px-2 py-1 rounded backdrop-blur-sm">
              {getStateMessage()}
            </span>
          </div>
        )}

        {/* 装饰 */}
        <div className="absolute top-4 right-4 flex space-x-2">
          <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse" />
          <div className="w-2 h-2 bg-blue-400 rounded-full animate-pulse delay-100" />
          <div className="w-2 h-2 bg-purple-400 rounded-full animate-pulse delay-200" />
        </div>
      </div>
    </div>
  )
}