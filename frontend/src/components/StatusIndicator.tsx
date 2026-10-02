import React from 'react'
import { useChatStore } from '../store/chatStore'

export const StatusIndicator: React.FC = () => {
  const { avatarState, isAvatarReady, isLoading, error } = useChatStore()

  const getStatusColor = () => {
    if (error) return 'bg-red-500'
    if (isLoading) return 'bg-yellow-500 animate-pulse'
    if (!isAvatarReady) return 'bg-gray-400'
    
    switch (avatarState) {
      case 'listening':
        return 'bg-blue-500 animate-pulse'
      case 'thinking':
        return 'bg-yellow-500 animate-pulse'
      case 'speaking':
        return 'bg-green-500 animate-pulse'
      default:
        return 'bg-green-500'
    }
  }

  const getStatusText = () => {
    if (error) return `Error: ${error}`
    if (isLoading) return 'Processing...'
    if (!isAvatarReady) return 'Avatar not ready'
    
    switch (avatarState) {
      case 'listening':
        return 'Listening...'
      case 'thinking':
        return 'AI is thinking...'
      case 'speaking':
        return 'Speaking...'
      default:
        return 'Ready'
    }
  }

  return (
    <div className="flex items-center space-x-2 px-4 py-2 bg-white rounded-full shadow-md">
      <div className={`w-3 h-3 rounded-full ${getStatusColor()}`} />
      <span className="text-sm font-medium text-gray-700">
        {getStatusText()}
      </span>
    </div>
  )
}
