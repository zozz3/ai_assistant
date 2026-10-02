import React, { useCallback, useEffect, useRef, useState } from 'react'
import axios from 'axios'

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000/api'
const apiClient = axios.create({ baseURL: API_BASE, timeout: 60000 })

/**
 * 阿里云数字人「播报视频合成」组件
 *
 * 后端流程（全部已实现并验证可用，实测 33 秒出片）：
 *   1. POST /config/avatar/generate  → 拿到 task_id（立即返回）
 *   2. GET  /config/avatar/status/{task_id} → 每 3s 轮询
 *   3. status=SUCCESS → 返回 video_url / cover_url / caption_url
 *   4. <video> 直接播放 OSS 上的 mp4
 *
 * 官方文档：
 *   https://help.aliyun.com/zh/avatar/avatar-application/developer-reference/developer-guide-broadcast-video-generation
 */

interface AvatarVariable {
  name: string
  type: string
}

interface TaskState {
  taskId: string
  videoId: string
  status: 'PENDING' | 'PROCESSING' | 'SUCCESS' | 'FAILED'
  progress: number
  videoUrl?: string
  coverUrl?: string
  captionUrl?: string
  error?: string
}

interface Props {
  /** 已保存的数字人配置（从后端 /config/avatar 读取） */
  config: any
  /** 默认填充的播报文案 */
  defaultText?: string
  /** 生成成功回调（把文案 + 视频 URL 交给上层，比如塞进聊天记录） */
  onGenerated?: (payload: { text: string; videoUrl: string; coverUrl?: string }) => void
  className?: string
}

const STATUS_TEXT: Record<TaskState['status'], string> = {
  PENDING: '排队中',
  PROCESSING: '合成中',
  SUCCESS: '已完成',
  FAILED: '失败',
}

const STATUS_COLOR: Record<TaskState['status'], string> = {
  PENDING: '#f59e0b',
  PROCESSING: '#3b82f6',
  SUCCESS: '#10b981',
  FAILED: '#ef4444',
}

export const AvatarVideoGenerator: React.FC<Props> = ({
  config,
  defaultText = '',
  onGenerated,
  className = '',
}) => {
  const [text, setText] = useState(defaultText)
  const [variables, setVariables] = useState<AvatarVariable[]>([])
  const [task, setTask] = useState<TaskState | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const pollTimer = useRef<number | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)

  // 组件挂载时，如果配置里有 template_id 就拉一次变量列表
  useEffect(() => {
    if (!config?.template_id) return
    let cancelled = false
    ;(async () => {
      try {
        const r = await apiClient.post('/config/avatar/test', { config })
        if (!cancelled && r.data.success) {
          setVariables(r.data.variables || [])
        }
      } catch (e) {
        console.error('[AvatarVideo] 拉取模板变量失败', e)
      }
    })()
    return () => { cancelled = true }
  }, [config?.template_id])

  // 卸载时清掉轮询
  useEffect(() => () => {
    if (pollTimer.current) window.clearInterval(pollTimer.current)
  }, [])

  const stopPolling = useCallback(() => {
    if (pollTimer.current) {
      window.clearInterval(pollTimer.current)
      pollTimer.current = null
    }
  }, [])

  const startPolling = useCallback((taskId: string) => {
    stopPolling()
    pollTimer.current = window.setInterval(async () => {
      try {
        const r = await apiClient.get(`/config/avatar/status/${taskId}`)
        const d = r.data
        if (!d.success) {
          setTask(prev => prev ? { ...prev, status: 'FAILED', error: d.error } : prev)
          stopPolling()
          return
        }
        setTask(prev => prev ? {
          ...prev,
          status: d.status,
          progress: d.progress ?? prev.progress,
          videoUrl: d.video_url ?? undefined,
          coverUrl: d.cover_url ?? undefined,
          captionUrl: d.caption_url ?? undefined,
        } : prev)

        if (d.status === 'SUCCESS' || d.status === 'FAILED') {
          stopPolling()
          if (d.status === 'SUCCESS' && d.video_url) {
            onGenerated?.({ text, videoUrl: d.video_url, coverUrl: d.cover_url || undefined })
          }
        }
      } catch (e: any) {
        console.error('[AvatarVideo] 轮询失败', e)
        setTask(prev => prev ? { ...prev, status: 'FAILED', error: e.message } : prev)
        stopPolling()
      }
    }, 3000)
  }, [stopPolling, onGenerated, text])

  const handleGenerate = async () => {
    if (!config?.template_id) {
      alert('请先在「设置 → 数字人」里选择或复制一个播报模板')
      return
    }
    if (!text.trim()) {
      alert('请输入播报文案')
      return
    }
    stopPolling()
    setSubmitting(true)
    try {
      // 把所有 text 类型变量都填上同一个文案（演示用；真实场景可分别填）
      const textVariables: Record<string, string> = {}
      const textVars = variables.filter(v => v.type === 'text')
      if (textVars.length === 0) {
        textVariables.test_text = text
      } else {
        textVars.forEach(v => { textVariables[v.name] = text })
      }

      const r = await apiClient.post('/config/avatar/generate', {
        config,
        text_variables: textVariables,
      })
      if (r.data.success) {
        setTask({
          taskId: r.data.task_id,
          videoId: r.data.video_id,
          status: 'PENDING',
          progress: 5,
        })
        startPolling(r.data.task_id)
      } else {
        alert(`❌ 提交失败：${r.data.error}`)
      }
    } catch (e: any) {
      alert(`❌ 网络错误：${e.message}`)
    } finally {
      setSubmitting(false)
    }
  }

  const handleDownload = () => {
    if (!task?.videoUrl) return
    const a = document.createElement('a')
    a.href = task.videoUrl
    a.download = `avatar-${task.videoId}.mp4`
    a.target = '_blank'
    a.click()
  }

  const busy = submitting || (task !== null && (task.status === 'PENDING' || task.status === 'PROCESSING'))

  return (
    <div
      className={className}
      style={{
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid rgba(255,255,255,0.1)',
        borderRadius: '12px',
        padding: '16px',
        color: '#fff',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
        <span style={{ fontSize: '20px' }}>🎬</span>
        <div>
          <div style={{ fontSize: '15px', fontWeight: 600 }}>数字人播报视频</div>
          <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.5)' }}>
            {config?.template_id ? `模板 ${config.template_id.slice(0, 20)}...` : '未配置模板'}
          </div>
        </div>
      </div>

      {/* 文案输入 */}
      <textarea
        value={text}
        onChange={e => setText(e.target.value)}
        placeholder="输入要数字人播报的文案，例如：大家好，欢迎来到阿里云数字人演示。"
        rows={3}
        style={{
          width: '100%',
          background: 'rgba(0,0,0,0.3)',
          border: '1px solid rgba(255,255,255,0.15)',
          borderRadius: '8px',
          padding: '10px',
          color: '#fff',
          fontSize: '14px',
          fontFamily: 'inherit',
          resize: 'vertical',
          marginBottom: '12px',
        }}
      />

      {/* 变量提示 */}
      {variables.length > 0 && (
        <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.5)', marginBottom: '10px' }}>
          模板变量：
          {variables.map(v => (
            <span key={v.name} style={{ marginRight: '8px' }}>
              <code style={{ background: 'rgba(0,0,0,0.3)', padding: '1px 5px', borderRadius: '3px' }}>
                {v.name}
              </code>
              <span style={{ marginLeft: '3px', color: v.type === 'text' ? '#10b981' : '#f59e0b' }}>
                {v.type}
              </span>
            </span>
          ))}
        </div>
      )}

      {/* 操作按钮 */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
        <button
          onClick={handleGenerate}
          disabled={busy || !config?.template_id}
          style={{
            flex: 1,
            padding: '10px 16px',
            borderRadius: '8px',
            border: 'none',
            background: busy || !config?.template_id ? '#6b7280' : '#10b981',
            color: '#fff',
            fontSize: '14px',
            fontWeight: 600,
            cursor: busy || !config?.template_id ? 'not-allowed' : 'pointer',
          }}
        >
          {busy ? '⏳ 生成中...' : '🎥 生成播报视频'}
        </button>
        {task?.videoUrl && (
          <button
            onClick={handleDownload}
            style={{
              padding: '10px 16px',
              borderRadius: '8px',
              border: '1px solid rgba(255,255,255,0.2)',
              background: 'transparent',
              color: '#fff',
              fontSize: '14px',
              cursor: 'pointer',
            }}
          >
            ⬇️ 下载
          </button>
        )}
      </div>

      {/* 进度 / 结果 */}
      {task && (
        <div
          style={{
            background: 'rgba(0,0,0,0.25)',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: '8px',
            padding: '12px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
            <span
              style={{
                width: '8px', height: '8px', borderRadius: '50%',
                background: STATUS_COLOR[task.status],
                animation: task.status === 'PROCESSING' ? 'pulse 1.5s infinite' : 'none',
              }}
            />
            <span style={{ fontSize: '13px', color: STATUS_COLOR[task.status], fontWeight: 600 }}>
              {STATUS_TEXT[task.status]}
            </span>
            <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.4)', marginLeft: 'auto' }}>
              videoId: {task.videoId}
            </span>
          </div>

          {/* 进度条 */}
          {(task.status === 'PENDING' || task.status === 'PROCESSING') && (
            <>
              <div style={{ height: '6px', background: 'rgba(255,255,255,0.1)', borderRadius: '3px', overflow: 'hidden' }}>
                <div
                  style={{
                    height: '100%',
                    width: `${task.progress}%`,
                    background: 'linear-gradient(90deg, #3b82f6, #10b981)',
                    transition: 'width 0.5s ease',
                  }}
                />
              </div>
              <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.5)', marginTop: '6px' }}>
                通常需要 30~90 秒，请稍候…
              </div>
            </>
          )}

          {/* 失败 */}
          {task.status === 'FAILED' && (
            <div style={{ fontSize: '12px', color: '#fca5a5', whiteSpace: 'pre-wrap' }}>
              ❌ {task.error || '合成失败'}
            </div>
          )}

          {/* 成功：显示视频 */}
          {task.status === 'SUCCESS' && task.videoUrl && (
            <div>
              <video
                ref={videoRef}
                src={task.videoUrl}
                poster={task.coverUrl}
                controls
                autoPlay
                playsInline
                style={{
                  width: '100%',
                  borderRadius: '8px',
                  marginTop: '8px',
                  background: '#000',
                }}
              />
              <div style={{ display: 'flex', gap: '12px', marginTop: '8px', fontSize: '11px' }}>
                {task.captionUrl && (
                  <a
                    href={task.captionUrl}
                    target="_blank"
                    rel="noreferrer"
                    style={{ color: '#93c5fd' }}
                  >
                    📄 下载字幕 SRT
                  </a>
                )}
                <a
                  href={task.videoUrl}
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: '#93c5fd' }}
                >
                  🔗 在新窗口打开
                </a>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default AvatarVideoGenerator
