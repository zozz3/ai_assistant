import { useEffect, useState, useCallback } from 'react'
import { api } from '../services/api'
import type { SceneId } from '../store/chatStore'

export interface SessionMeta {
  session_id: string
  title: string
  scene: SceneId
  created_at: string
  updated_at: string
  message_count: number
  grammar_checks?: Array<{
    user_text: string
    checks: Array<{ original: string; corrected: string; explanation: string }>
    created_at: string
  }>
}

interface HistorySidebarProps {
  isOpen: boolean
  onClose: () => void
  currentSessionId: string | null
  onSelectSession: (sessionId: string, sessionMeta: SessionMeta) => void
  onNewSession: () => void
  onSessionDeleted: (sessionId: string) => void
}

/**
 * 历史对话侧边栏
 * - 列出所有 session（按 updated_at 倒序）
 * - 点击切换
 * - 重命名 / 删除
 * - 显示场景标签 + 消息数
 */
export const HistorySidebar: React.FC<HistorySidebarProps> = ({
  isOpen,
  onClose,
  currentSessionId,
  onSelectSession,
  onNewSession,
  onSessionDeleted,
}) => {
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [loading, setLoading] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')

  // 拉列表
  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const resp = await api.listSessions()
      setSessions(resp.sessions || [])
    } catch (e) {
      console.error('[HistorySidebar] 拉取失败:', e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (isOpen) refresh()
  }, [isOpen, refresh])

  // 删除
  const handleDelete = useCallback(
    async (sid: string, e: React.MouseEvent) => {
      e.stopPropagation()
      if (!confirm('确定删除这个对话？历史记录会从磁盘彻底清除。')) return
      try {
        await api.clearChatHistory(sid)
        setSessions((cur) => cur.filter((s) => s.session_id !== sid))
        onSessionDeleted(sid)
      } catch (err) {
        console.error('[HistorySidebar] 删除失败:', err)
        alert('删除失败：' + (err as any)?.message)
      }
    },
    [onSessionDeleted]
  )

  // 重命名
  const startEdit = (s: SessionMeta, e: React.MouseEvent) => {
    e.stopPropagation()
    setEditingId(s.session_id)
    setEditTitle(s.title)
  }
  const commitEdit = async (sid: string) => {
    const title = editTitle.trim()
    if (!title) {
      setEditingId(null)
      return
    }
    try {
      await api.updateSessionTitle(sid, title)
      setSessions((cur) =>
        cur.map((s) => (s.session_id === sid ? { ...s, title } : s))
      )
    } catch (e) {
      console.error('[HistorySidebar] 重命名失败:', e)
    } finally {
      setEditingId(null)
    }
  }

  // 时间格式化
  const fmtTime = (iso: string) => {
    if (!iso) return ''
    const d = new Date(iso)
    if (isNaN(d.getTime())) return ''
    const now = new Date()
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate()
    if (sameDay) {
      return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
    }
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }

  const sceneLabel = (s: SceneId) =>
    s === 'interview' ? '💼 面试' : '🗣️ 日常'

  return (
    <>
      {/* 背景遮罩 */}
      {isOpen && (
        <div
          onClick={onClose}
          className="fixed inset-0 bg-black/40 z-40 transition-opacity"
        />
      )}
      {/* 抽屉 */}
      <div
        className={`fixed top-0 left-0 h-full w-80 max-w-[85vw] bg-white z-50 transform transition-transform duration-300 ease-in-out shadow-2xl ${
          isOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
        style={{ display: 'flex', flexDirection: 'column' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-gradient-to-r from-blue-600 to-purple-600 text-white flex-shrink-0">
          <h2 className="text-base font-bold flex items-center gap-2">
            <span>📚</span>
            <span>对话历史</span>
          </h2>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-full bg-white/20 hover:bg-white/30 flex items-center justify-center text-lg leading-none"
            title="关闭"
          >
            ×
          </button>
        </div>

        {/* 新建按钮 */}
        <div className="px-3 py-3 border-b border-gray-100 flex-shrink-0">
          <button
            onClick={() => {
              onNewSession()
              onClose()
            }}
            className="w-full px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2"
          >
            <span className="text-lg leading-none">＋</span>
            <span>新建对话</span>
          </button>
        </div>

        {/* 列表 */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {loading ? (
            <div className="p-6 text-center text-sm text-gray-400">加载中…</div>
          ) : sessions.length === 0 ? (
            <div className="p-6 text-center text-sm text-gray-400">
              <div className="text-4xl mb-2">💬</div>
              <p>暂无历史对话</p>
              <p className="text-xs mt-1">开始一次对话后会自动保存</p>
            </div>
          ) : (
            <ul className="divide-y divide-gray-100">
              {sessions.map((s) => {
                const isCurrent = s.session_id === currentSessionId
                const isEditing = editingId === s.session_id
                return (
                  <li
                    key={s.session_id}
                    onClick={() => {
                      if (isEditing) return
                      onSelectSession(s.session_id, s)
                    }}
                    className={`px-3 py-3 cursor-pointer transition-colors group ${
                      isCurrent
                        ? 'bg-blue-50 border-l-4 border-blue-500'
                        : 'hover:bg-gray-50 border-l-4 border-transparent'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        {isEditing ? (
                          <input
                            value={editTitle}
                            autoFocus
                            onChange={(e) => setEditTitle(e.target.value)}
                            onBlur={() => commitEdit(s.session_id)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') commitEdit(s.session_id)
                              else if (e.key === 'Escape') setEditingId(null)
                            }}
                            onClick={(e) => e.stopPropagation()}
                            className="w-full px-2 py-1 text-sm border border-blue-400 rounded outline-none"
                          />
                        ) : (
                          <h3
                            className={`text-sm font-medium truncate ${
                              isCurrent ? 'text-blue-700' : 'text-gray-800'
                            }`}
                            title={s.title}
                          >
                            {s.title}
                          </h3>
                        )}
                        <div className="flex items-center gap-2 mt-1 text-xs text-gray-500">
                          <span
                            className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                              s.scene === 'interview'
                                ? 'bg-purple-100 text-purple-700'
                                : 'bg-green-100 text-green-700'
                            }`}
                          >
                            {sceneLabel(s.scene)}
                          </span>
                          <span>{s.message_count} 条</span>
                          <span>·</span>
                          <span>{fmtTime(s.updated_at)}</span>
                        </div>
                      </div>
                      {/* 操作按钮：常驻显示，方便手机 / 不熟练 hover 的用户找到 */}
                      <div className="flex flex-col gap-1">
                        <button
                          onClick={(e) => startEdit(s, e)}
                          title="重命名"
                          className="w-6 h-6 text-gray-500 hover:text-blue-600 text-xs leading-none flex items-center justify-center"
                        >
                          ✏️
                        </button>
                        <button
                          onClick={(e) => handleDelete(s.session_id, e)}
                          title="删除"
                          className="w-6 h-6 text-gray-500 hover:text-red-600 text-xs leading-none flex items-center justify-center"
                        >
                          🗑️
                        </button>
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        {/* Footer */}
        <div className="px-3 py-2 border-t border-gray-100 text-[10px] text-gray-400 text-center flex-shrink-0">
          共 {sessions.length} 个对话 · 数据保存在后端磁盘
        </div>
      </div>
    </>
  )
}

export default HistorySidebar