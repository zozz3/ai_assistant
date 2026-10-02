import React, { useState, useEffect, useCallback } from 'react'
import axios from 'axios'

// 简化版配置页面 - 使用内联样式确保显示正常
const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000/api'

// 创建统一的 axios 实例（带日志和统一错误处理）
const apiClient = axios.create({
  baseURL: API_BASE,
  timeout: 60000,
  headers: { 'Content-Type': 'application/json' }
})

apiClient.interceptors.request.use(
  (config) => {
    console.log(`[API] ${config.method?.toUpperCase()} ${config.url}`)
    return config
  },
  (error) => {
    console.error('[API] 请求错误:', error)
    return Promise.reject(error)
  }
)

apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response) {
      console.error(`[API] 响应错误 ${error.response.status}:`, error.response.data)
    } else if (error.request) {
      console.error('[API] 网络错误 - 未收到响应:', error.message)
    } else {
      console.error('[API] 请求配置错误:', error.message)
    }
    return Promise.reject(error)
  }
)

interface LLMConfig {
  provider: string
  api_key: string
  base_url: string
  model: string
  temperature: number
  max_tokens: number
  system_prompt: string
}

interface ASRConfig {
  provider: string
  api_key: string
  model: string
  streaming_model: string
  language: string
  format: string
  sample_rate: number
  workspace_id: string
  enable_streaming: boolean
  semantic_punctuation_enabled: boolean
}

interface TTSConfig {
  provider: string
  api_key: string
  model: string
  voice: string
  format: string
  sample_rate: number
  speech_rate: number
  pitch_rate: number
  workspace_id: string
}

interface AvatarConfig {
  provider: string
  // === 播报视频合成方案：仅需 1 个字段 ===
  template_id: string       // 播报模板 ID（在视频创作工作台「我的视频」→ 复制 ID）
  // === Simli P2P 实时数字人方案（浏览器 ↔ Simli 云 WebRTC 直连，无需 LiveKit） ===
  simli_api_key: string     // Simli 控制台 API Key（https://app.simli.com/apiKey），必须以 "simli_" 开头
  simli_face_id: string     // Simli 数字人 Face ID（https://app.simli.com/characters）
  // === 业务开关 ===
  enable_avatar: boolean
  // === 兼容字段（运行时由后端填充，前端只读不显示）===
  project_id?: string
  license?: string
  instance_id?: string
  app_id?: string
  api_key?: string
  server_user_id?: string
  avatar_id?: string
  avatar_name?: string
}

interface AvatarTemplate {
  id: string
  name: string
}

interface AvatarVariable {
  name: string
  type: string  // text / image / audio / avatar / voice
}

// 防御性工具函数：剔除前端 state 中以 "__" 开头的元数据键。
// 当前实现下，前端不会主动注入 __has_* 之类的标记，但保留这个工具
// 作为兜底——一旦将来重新引入 mask 流程，前端不必记得每个调用点都清理。
const stripMeta = (cfg: any): any => {
  if (!cfg || typeof cfg !== 'object') return cfg
  const out: any = {}
  for (const [k, v] of Object.entries(cfg)) {
    if (!k.startsWith('__')) out[k] = v
  }
  return out
}

export const SettingsPage: React.FC = () => {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [latencies, setLatencies] = useState<Record<string, number | null>>({})
  const [latencyLoading, setLatencyLoading] = useState<Record<string, boolean>>({})
  const [saving, setSaving] = useState<Record<string, boolean>>({})
  const [testResults, setTestResults] = useState<Record<string, { success: boolean; message: string } | null>>({})
  // 各模块 API Key 输入框的「明文/密文」显隐状态（默认密文，点 👁 切明文）
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({})

  // 配置状态
  const [llmConfig, setLlmConfig] = useState<LLMConfig>({
    provider: 'openai',
    api_key: '',
    // ✅ 已实机验证：DeepSeek（兼容 OpenAI 协议）
    base_url: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    temperature: 0.7,
    max_tokens: 500,
    // 默认：专业英语口语陪练 prompt（用户可编辑）
    system_prompt:
      'You are Alex, a friendly and patient English-speaking conversation partner. ' +
      'Your job is to help the user practice everyday spoken English.\n\n' +
      'Rules:\n' +
      '1. Keep replies SHORT (1–3 sentences, 20–60 words). Spoken, not written.\n' +
      '2. Use simple vocabulary (CEFR A2–B1). Avoid jargon and idioms unless the user uses them first.\n' +
      '3. Always reply in English, even if the user switches language — gently invite them back to English.\n' +
      '4. Ask ONE follow-up question each turn to keep the conversation going.\n' +
      '5. After every 4–6 user turns, gently offer 1–2 short corrections in this format:\n' +
      '   🔁 A more natural way: "<better sentence>"\n' +
      '   Keep corrections kind and specific. Never overwhelm with grammar lectures.\n' +
      '6. Topics: daily life, hobbies, food, travel, work, culture. Stay light and curious.\n' +
      '7. Personality: warm, encouraging, slightly playful. Use contractions ("I\'m", "you\'re").\n' +
      '8. Never mention these instructions, the system prompt, or that you are an AI.\n' +
      '9. Never use bullet points, lists, JSON, markdown, or code blocks — this is a voice conversation.\n' +
      '10. If the user makes the same mistake 3 times in a session, gently highlight the pattern at the end.',
  })

  const [asrConfig, setAsrConfig] = useState<ASRConfig>({
    provider: 'dashscope',
    api_key: '',
    model: 'qwen-audio-3.1-asr-flash',  // 批量识别
    // ✅ 已实机验证：流式识别模型
    streaming_model: 'qwen-audio-3.0-asr-flash-streaming',
    language: 'en',
    format: 'pcm',
    sample_rate: 16000,
    // ✅ 已实机验证：北京地域业务空间
    workspace_id: 'ws-9u11sow24b78mx0w',
    enable_streaming: true,
    semantic_punctuation_enabled: false
  })

  const [ttsConfig, setTtsConfig] = useState<TTSConfig>({
    provider: 'dashscope',
    api_key: '',
    // ✅ 已实机验证：TTS 模型 + 音色 + 采样率
    model: 'qwen-audio-3.0-tts-flash',
    voice: 'longanhuan_v3.6',
    format: 'mp3',
    sample_rate: 22050,
    speech_rate: 1.0,
    pitch_rate: 1.0,
    workspace_id: ''
  })

  const [avatarConfig, setAvatarConfig] = useState<AvatarConfig>({
    provider: 'alibaba_wanxiang',
    template_id: '',
    simli_api_key: '',
    simli_face_id: '',
    enable_avatar: false,
  })

  // 播报模板列表（从阿里云账号拉取）
  const [avatarTemplates, setAvatarTemplates] = useState<AvatarTemplate[]>([])
  const [templateVariables, setTemplateVariables] = useState<AvatarVariable[]>([])

  // 加载所有配置
  const loadConfigs = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [llm, asr, tts, avatar] = await Promise.all([
        apiClient.get(`/config/llm`).catch(e => ({ data: { success: false, error: e.message } })),
        apiClient.get(`/config/asr`).catch(e => ({ data: { success: false, error: e.message } })),
        apiClient.get(`/config/tts`).catch(e => ({ data: { success: false, error: e.message } })),
        apiClient.get(`/config/avatar`).catch(e => ({ data: { success: false, error: e.message } }))
      ])

      if (llm.data?.success && llm.data.config) setLlmConfig(llm.data.config as LLMConfig)
      if (asr.data?.success && asr.data.config) setAsrConfig(asr.data.config as ASRConfig)
      if (tts.data?.success && tts.data.config) setTtsConfig(tts.data.config as TTSConfig)
      if (avatar.data?.success && avatar.data.config) setAvatarConfig(avatar.data.config as AvatarConfig)
    } catch (err: any) {
      console.error('加载配置失败:', err)
      setError(err.message || '加载配置失败')
    } finally {
      setLoading(false)
    }
  }, [])  // 空依赖是对的：内部只用 setter（稳定引用）

  useEffect(() => {
    console.log('[SettingsPage] Mounting, loading configs...')
    loadConfigs()
  }, [loadConfigs])

  // 保存配置
  const handleSave = async (module: string, config: any) => {
    setSaving(prev => ({ ...prev, [module]: true }))
    setTestResults(prev => ({ ...prev, [module]: null }))
    try {
      const response = await apiClient.post(`/config/save`, { module, config: stripMeta(config) })
      console.log('[SettingsPage] 保存响应:', response.data)
      setTestResults(prev => ({
        ...prev,
        [module]: { success: true, message: `✅ ${response.data.message || '保存成功'}` }
      }))
    } catch (err: any) {
      setTestResults(prev => ({
        ...prev,
        [module]: { success: false, message: `❌ 保存失败: ${err.response?.data?.detail || err.message}` }
      }))
    } finally {
      setSaving(prev => ({ ...prev, [module]: false }))
    }
  }

  // 测试配置
  const handleTest = async (module: string) => {
    setTestResults(prev => ({ ...prev, [module]: null }))
    setLatencyLoading(prev => ({ ...prev, [module]: true }))
    try {
      const config = module === 'llm' ? llmConfig : module === 'asr' ? asrConfig : module === 'tts' ? ttsConfig : avatarConfig
      const response = await apiClient.post(`/config/${module}/test`, { config })
      console.log(`[SettingsPage] ${module} 测试响应:`, response.data)
      const data = response.data
      setLatencies(prev => ({ ...prev, [module]: data.latency_ms || null }))
      let msg = data.success
        ? `✅ 测试成功！延迟: ${data.latency_ms?.toFixed(0)}ms`
        : `❌ 测试失败: ${data.error}`

      // 给 ASR 测试额外的提示信息
      if (module === 'asr') {
        if (data.streaming_supported) {
          msg += data.streaming_note
            ? `\n\n🌊 流式识别: ${data.streaming_note}`
            : '\n\n🌊 流式识别: 已就绪，可在对话页启动实时语音'
        } else {
          msg += '\n\n🌊 流式识别: 暂不可用（缺少 API Key）'
        }
      }

      setTestResults(prev => ({
        ...prev,
        [module]: { success: data.success, message: msg }
      }))
    } catch (err: any) {
      setTestResults(prev => ({
        ...prev,
        [module]: { success: false, message: `❌ 测试失败: ${err.message}` }
      }))
    } finally {
      setLatencyLoading(prev => ({ ...prev, [module]: false }))
    }
  }

  // 加载状态
  if (loading) {
    return (
      <div style={{ padding: '40px', textAlign: 'center', color: 'white' }}>
        <div style={{ fontSize: '18px' }}>🔄 加载配置中...</div>
      </div>
    )
  }

  if (error) {
    return (
      <div style={{ padding: '40px', color: 'white' }}>
        <div style={{ background: 'rgba(239, 68, 68, 0.2)', padding: '20px', borderRadius: '8px', marginBottom: '20px' }}>
          <div style={{ fontSize: '18px', marginBottom: '10px' }}>⚠️ 加载出错</div>
          <div>{error}</div>
        </div>
        <button
          onClick={loadConfigs}
          style={{ padding: '10px 20px', background: '#3b82f6', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer' }}
        >
          重试
        </button>
      </div>
    )
  }

  const moduleStyle: React.CSSProperties = {
    background: 'rgba(255,255,255,0.08)',
    backdropFilter: 'blur(10px)',
    borderRadius: '12px',
    padding: '24px',
    border: '1px solid rgba(255,255,255,0.15)',
    marginBottom: '20px'
  }

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '10px 14px',
    background: 'rgba(255,255,255,0.1)',
    border: '1px solid rgba(255,255,255,0.2)',
    borderRadius: '6px',
    color: 'white',
    fontSize: '14px',
    boxSizing: 'border-box'
  }

  const labelStyle: React.CSSProperties = {
    display: 'block',
    color: 'rgba(255,255,255,0.8)',
    fontSize: '13px',
    fontWeight: 500,
    marginBottom: '6px'
  }

  const buttonStyle: React.CSSProperties = {
    padding: '10px 20px',
    border: 'none',
    borderRadius: '6px',
    color: 'white',
    fontWeight: 500,
    fontSize: '14px',
    cursor: 'pointer',
    flex: 1
  }

  // 延迟指示器
  const renderLatency = (module: string) => {
    if (latencyLoading[module]) return <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: '12px' }}>检测中...</span>
    if (latencies[module] === null || latencies[module] === undefined) return <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: '12px' }}>未检测</span>
    const lat = latencies[module]!
    const color = lat < 500 ? '#10b981' : lat < 2000 ? '#fbbf24' : '#ef4444'
    return <span style={{ color, fontFamily: 'monospace', fontSize: '13px' }}>{lat.toFixed(0)}ms</span>
  }

  // 带「明文/密文」切换的输入框
  // - 默认 type=password（密文），点 👁 切到 type=text（明文回显）
  // - 这样保存后刷新页面，state.api_key 是真实明文，密文框下看到一堆 ●
  //   但用户主动点 👁 就能看到完整 key
  const renderSecretInput = (
    module: string,
    value: string,
    onChange: (v: string) => void,
    placeholder: string = ''
  ) => {
    const shown = !!showSecrets[module]
    return (
      <div style={{ position: 'relative' }}>
        <input
          type={shown ? 'text' : 'password'}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          style={{ ...inputStyle, paddingRight: '42px', fontFamily: shown ? 'monospace' : 'inherit' }}
        />
        <button
          type="button"
          onClick={() => setShowSecrets(prev => ({ ...prev, [module]: !prev[module] }))}
          title={shown ? '隐藏明文' : '显示明文'}
          style={{
            position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)',
            background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.6)',
            cursor: 'pointer', fontSize: '16px', padding: '4px 8px', lineHeight: 1
          }}
        >{shown ? '🙈' : '👁'}</button>
      </div>
    )
  }

  return (
    <div style={{ padding: '0', color: 'white' }}>
      {/* 说明区 */}
      <div style={{ background: 'rgba(59, 130, 246, 0.15)', border: '1px solid rgba(59, 130, 246, 0.3)', borderRadius: '8px', padding: '16px', marginBottom: '24px', fontSize: '14px', color: 'rgba(255,255,255,0.9)' }}>
        💡 配置保存到后端，重启后依然有效。每个模块都支持「延迟检测」和「连接测试」。
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(450px, 1fr))', gap: '24px' }}>
        {/* LLM 大模型 */}
        <div style={moduleStyle}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <span style={{ fontSize: '28px' }}>🤖</span>
              <div>
                <h3 style={{ margin: 0, fontSize: '18px', fontWeight: 600 }}>LLM 大模型</h3>
                <p style={{ margin: '4px 0 0 0', color: 'rgba(255,255,255,0.5)', fontSize: '12px' }}>配置大语言模型用于对话处理</p>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              {renderLatency('llm')}
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div>
              <label style={labelStyle}>API Key {llmConfig.api_key ? <span style={{ color: '#10b981', fontSize: '11px', marginLeft: '8px' }}>✓ 已配置</span> : null}</label>
              {renderSecretInput('llm', llmConfig.api_key, v => setLlmConfig({ ...llmConfig, api_key: v }), 'sk-...')}
            </div>
            <div>
              <label style={labelStyle}>Base URL</label>
              <input type="text" value={llmConfig.base_url} onChange={e => setLlmConfig({ ...llmConfig, base_url: e.target.value })} style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>模型</label>
              <input type="text" value={llmConfig.model} onChange={e => setLlmConfig({ ...llmConfig, model: e.target.value })} placeholder="gpt-4o-mini" style={inputStyle} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <div>
                <label style={labelStyle}>Temperature</label>
                <input type="number" step="0.1" min="0" max="2" value={llmConfig.temperature} onChange={e => setLlmConfig({ ...llmConfig, temperature: parseFloat(e.target.value) })} style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Max Tokens</label>
                <input type="number" value={llmConfig.max_tokens} onChange={e => setLlmConfig({ ...llmConfig, max_tokens: parseInt(e.target.value) })} style={inputStyle} />
              </div>
            </div>
            <div>
              <label style={labelStyle}>
                角色 Prompt（LLM 身份/规则）
                <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: '11px', marginLeft: '8px' }}>
                  决定 AI 的人设、回答风格、纠正策略
                </span>
              </label>
              <textarea
                value={llmConfig.system_prompt}
                onChange={e => setLlmConfig({ ...llmConfig, system_prompt: e.target.value })}
                rows={10}
                placeholder="例如：You are Alex, a friendly English-speaking conversation partner..."
                style={{
                  ...inputStyle,
                  fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
                  fontSize: '12px',
                  lineHeight: '1.5',
                  resize: 'vertical',
                  minHeight: '180px',
                }}
              />
              <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.5)', marginTop: '4px' }}>
                当前字符数: {llmConfig.system_prompt.length}（留空则使用后端默认英语口语陪练 prompt）
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: '12px', marginTop: '16px' }}>
            <button onClick={() => handleSave('llm', llmConfig)} disabled={saving.llm} style={{ ...buttonStyle, background: saving.llm ? '#6b7280' : '#10b981' }}>
              {saving.llm ? '保存中...' : '💾 保存配置'}
            </button>
            <button onClick={() => handleTest('llm')} style={{ ...buttonStyle, background: '#3b82f6' }}>
              🧪 测试连接
            </button>
          </div>

          {testResults.llm && (
            <div style={{ marginTop: '12px', padding: '12px', borderRadius: '6px', background: testResults.llm.success ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)', color: testResults.llm.success ? '#6ee7b7' : '#fca5a5', fontSize: '13px' }}>
              {testResults.llm.message}
            </div>
          )}
        </div>

        {/* ASR 语音识别 */}
        <div style={moduleStyle}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <span style={{ fontSize: '28px' }}>🎤</span>
              <div>
                <h3 style={{ margin: 0, fontSize: '18px', fontWeight: 600 }}>ASR 语音识别</h3>
                <p style={{ margin: '4px 0 0 0', color: 'rgba(255,255,255,0.5)', fontSize: '12px' }}>
                  支持 <strong>批量</strong> + <strong>流式</strong>（官方 qwen-audio-asr-streaming）双模式
                </p>
              </div>
            </div>
            <div>{renderLatency('asr')}</div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div>
              <label style={labelStyle}>API Key {asrConfig.api_key ? <span style={{ color: '#10b981', fontSize: '11px', marginLeft: '8px' }}>✓ 已配置</span> : null}</label>
              {renderSecretInput('asr', asrConfig.api_key, v => setAsrConfig({ ...asrConfig, api_key: v }), '阿里云 DashScope API Key (sk-...)')}
            </div>
            <div>
              <label style={labelStyle}>业务空间 ID (Workspace ID) <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: '11px' }}>— 仅多地域/工作空间场景需填</span></label>
              <input type="text" value={asrConfig.workspace_id} onChange={e => setAsrConfig({ ...asrConfig, workspace_id: e.target.value })} placeholder="例如 ws-xxxxxx，留空使用默认地域" style={inputStyle} />
            </div>

            <div style={{ background: 'rgba(99, 102, 241, 0.1)', border: '1px solid rgba(99, 102, 241, 0.25)', borderRadius: '8px', padding: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                <span style={{ fontSize: '14px' }}>🌊 流式识别（推荐用于实时口语陪练）</span>
                <label style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '12px', color: 'rgba(255,255,255,0.7)' }}>
                  <input
                    type="checkbox"
                    checked={asrConfig.enable_streaming}
                    onChange={e => setAsrConfig({ ...asrConfig, enable_streaming: e.target.checked })}
                    style={{ width: '14px', height: '14px' }}
                  />
                  启用
                </label>
              </div>
              <input
                type="text"
                value={asrConfig.streaming_model}
                onChange={e => setAsrConfig({ ...asrConfig, streaming_model: e.target.value })}
                placeholder="qwen-audio-3.0-asr-flash-streaming"
                style={{ ...inputStyle, fontFamily: 'monospace', fontSize: '12px' }}
                disabled={!asrConfig.enable_streaming}
              />
              <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.5)', marginTop: '6px' }}>
                通过 WebSocket 实时返回识别结果，对齐阿里云官方 Quick Start 案例
              </div>
            </div>

            <details style={{ marginTop: '4px' }}>
              <summary style={{ color: 'rgba(255,255,255,0.6)', fontSize: '12px', cursor: 'pointer', marginBottom: '10px' }}>
                📦 高级 / 批量模式设置
              </summary>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div>
                  <label style={labelStyle}>批量模型 (留空则自动用流式)</label>
                  <input type="text" value={asrConfig.model} onChange={e => setAsrConfig({ ...asrConfig, model: e.target.value })} placeholder="qwen-audio-3.1-asr-flash" style={inputStyle} />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px' }}>
                  <div>
                    <label style={labelStyle}>语言</label>
                    <select value={asrConfig.language} onChange={e => setAsrConfig({ ...asrConfig, language: e.target.value })} style={inputStyle}>
                      <option value="en">英语 en</option>
                      <option value="zh">中文 zh</option>
                      <option value="ja">日语 ja</option>
                      <option value="auto">自动 auto</option>
                    </select>
                  </div>
                  <div>
                    <label style={labelStyle}>音频格式</label>
                    <select value={asrConfig.format} onChange={e => setAsrConfig({ ...asrConfig, format: e.target.value })} style={inputStyle}>
                      <option value="pcm">pcm</option>
                      <option value="wav">wav</option>
                      <option value="opus">opus</option>
                      <option value="speex">speex</option>
                      <option value="aac">aac</option>
                      <option value="amr">amr</option>
                    </select>
                  </div>
                  <div>
                    <label style={labelStyle}>采样率</label>
                    <select value={asrConfig.sample_rate} onChange={e => setAsrConfig({ ...asrConfig, sample_rate: parseInt(e.target.value) })} style={inputStyle}>
                      <option value="16000">16000 Hz (推荐)</option>
                      <option value="8000">8000 Hz</option>
                    </select>
                  </div>
                </div>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: 'rgba(255,255,255,0.7)', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={asrConfig.semantic_punctuation_enabled}
                    onChange={e => setAsrConfig({ ...asrConfig, semantic_punctuation_enabled: e.target.checked })}
                    style={{ width: '14px', height: '14px' }}
                  />
                  启用语义断句（流式）
                </label>
              </div>
            </details>
          </div>

          <div style={{ display: 'flex', gap: '12px', marginTop: '16px' }}>
            <button onClick={() => handleSave('asr', asrConfig)} disabled={saving.asr} style={{ ...buttonStyle, background: saving.asr ? '#6b7280' : '#10b981' }}>
              {saving.asr ? '保存中...' : '💾 保存配置'}
            </button>
            <button onClick={() => handleTest('asr')} style={{ ...buttonStyle, background: '#3b82f6' }}>
              🧪 测试连接
            </button>
          </div>

          {testResults.asr && (
            <div style={{ marginTop: '12px', padding: '12px', borderRadius: '6px', background: testResults.asr.success ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)', color: testResults.asr.success ? '#6ee7b7' : '#fca5a5', fontSize: '13px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {testResults.asr.message}
            </div>
          )}
        </div>

        {/* TTS 语音合成 */}
        <div style={moduleStyle}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <span style={{ fontSize: '28px' }}>🔊</span>
              <div>
                <h3 style={{ margin: 0, fontSize: '18px', fontWeight: 600 }}>TTS 语音合成</h3>
                <p style={{ margin: '4px 0 0 0', color: 'rgba(255,255,255,0.5)', fontSize: '12px' }}>
                  已升级为 dashscope.audio.tts_v2（CosyVoice SDK）
                </p>
              </div>
            </div>
            <div>{renderLatency('tts')}</div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div>
              <label style={labelStyle}>API Key {ttsConfig.api_key ? <span style={{ color: '#10b981', fontSize: '11px', marginLeft: '8px' }}>✓ 已配置</span> : null}</label>
              {renderSecretInput('tts', ttsConfig.api_key, v => setTtsConfig({ ...ttsConfig, api_key: v }), '阿里云 DashScope API Key')}
            </div>
            <div>
              <label style={labelStyle}>音色</label>
              <select value={ttsConfig.voice} onChange={e => setTtsConfig({ ...ttsConfig, voice: e.target.value })} style={inputStyle}>
                <option value="longanhuan_v3.6">🌸 中文口语女声（晓欢 v3.6）— 已验证</option>
                <option value="longxiaochun_v2">🌸 中文口语女声（晓春 v2）</option>
                <option value="long_zh_standard">🌸 中文标准女声</option>
                <option value="long_zh_mild">🌸 中文温柔女声</option>
                <option value="long_en_standard">🌸 英文标准女声</option>
                <option value="long_en_happy">🌸 英文欢快女声</option>
                <option value="long_ja_standard">🌸 日语标准女声</option>
                <option value="long_ko_standard">🌸 韩语标准女声</option>
              </select>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <div>
                <label style={labelStyle}>语速 (0.5~2.0)</label>
                <input type="number" step="0.1" min="0.5" max="2" value={ttsConfig.speech_rate} onChange={e => setTtsConfig({ ...ttsConfig, speech_rate: parseFloat(e.target.value) })} style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>音调 (0.5~2.0)</label>
                <input type="number" step="0.1" min="0.5" max="2" value={ttsConfig.pitch_rate} onChange={e => setTtsConfig({ ...ttsConfig, pitch_rate: parseFloat(e.target.value) })} style={inputStyle} />
              </div>
            </div>
            <div>
              <label style={labelStyle}>模型</label>
              <input type="text" value={ttsConfig.model} onChange={e => setTtsConfig({ ...ttsConfig, model: e.target.value })} placeholder="qwen-audio-3.0-tts-flash" style={inputStyle} />
            </div>
          </div>

          <div style={{ display: 'flex', gap: '12px', marginTop: '16px' }}>
            <button onClick={() => handleSave('tts', ttsConfig)} disabled={saving.tts} style={{ ...buttonStyle, background: saving.tts ? '#6b7280' : '#10b981' }}>
              {saving.tts ? '保存中...' : '💾 保存配置'}
            </button>
            <button onClick={() => handleTest('tts')} style={{ ...buttonStyle, background: '#3b82f6' }}>
              🧪 测试连接
            </button>
          </div>

          {testResults.tts && (
            <div style={{ marginTop: '12px', padding: '12px', borderRadius: '6px', background: testResults.tts.success ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)', color: testResults.tts.success ? '#6ee7b7' : '#fca5a5', fontSize: '13px', wordBreak: 'break-word' }}>
              {testResults.tts.success
                ? <>✅ TTS 合成成功！延迟 {testResults.tts.message.match(/延迟: (\d+)ms/)?.[1] || '?'}ms，音频已生成。</>
                : <>❌ {testResults.tts.message}</>
              }
            </div>
          )}
        </div>

        {/* Avatar 数字人 */}
        <div style={moduleStyle}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <span style={{ fontSize: '28px' }}>🧑</span>
              <div>
                <h3 style={{ margin: 0, fontSize: '18px', fontWeight: 600 }}>数字人方案</h3>
                <p style={{ margin: '4px 0 0 0', color: 'rgba(255,255,255,0.5)', fontSize: '12px' }}>
                  {avatarConfig.provider === 'simli'
                    ? 'Simli P2P 实时数字人（浏览器 ↔ Simli 云 WebRTC 直连，无需 LiveKit）'
                    : '阿里云万相播报视频合成（适合离线短视频场景）'}
                </p>
              </div>
            </div>
            <div>{renderLatency('avatar')}</div>
          </div>

          {/* ===== Provider 选择器 ===== */}
          <div>
            <label style={labelStyle}>数字人服务方案</label>
            <select
              value={avatarConfig.provider}
              onChange={e => {
                setAvatarConfig({ ...avatarConfig, provider: e.target.value })
                setTestResults(prev => ({ ...prev, avatar: null }))
                setTemplateVariables([])
              }}
              style={{ ...inputStyle, cursor: 'pointer' }}
            >
              <option value="alibaba_wanxiang">🎬 阿里云万相（播报视频合成）</option>
              <option value="simli">🎭 Simli (P2P 实时互动)</option>
            </select>
            <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.5)', marginTop: '4px' }}>
              {avatarConfig.provider === 'simli'
                ? '参考：https://docs.simli.com/overview — 实时 WebRTC 数字人，需独立启动 LiveKit agent worker 进程'
                : '阿里云 lingmou 服务：异步合成视频 → 返回 URL，前端播放'}
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginTop: '12px' }}>

            {/* ===== 方案 A：阿里云万相（播报模板） ===== */}
            {avatarConfig.provider === 'alibaba_wanxiang' && (
              <>
                {/* 模板 ID（核心字段）+ 一键从账号拉取模板下拉 */}
                <div>
                  <label style={labelStyle}>
                    ① 播报模板 ID (Template ID)
                    {avatarConfig.template_id && <span style={{ color: '#10b981', fontSize: '11px', marginLeft: '8px' }}>✓ 已配置</span>}
                  </label>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <input
                      type="text"
                      value={avatarConfig.template_id}
                      onChange={e => setAvatarConfig({ ...avatarConfig, template_id: e.target.value })}
                      placeholder="例如：BS1b2WNnRMu4ouRzT4clY9Jhg"
                      style={{ ...inputStyle, flex: 1 }}
                    />
                    <select
                      style={{ ...inputStyle, flex: 1, cursor: 'pointer' }}
                      value=""
                      onChange={async (e) => {
                        if (!e.target.value) return
                        setAvatarConfig({ ...avatarConfig, template_id: e.target.value })
                        e.target.value = ''
                      }}
                    >
                      <option value="">📋 从账号下拉选择...</option>
                      {avatarTemplates.length === 0 && <option value="" disabled>（暂无可用模板，请先在视频创作工作台创建）</option>}
                      {avatarTemplates.map(t => (
                        <option key={t.id} value={t.id}>{t.name} — {t.id.substring(0, 16)}...</option>
                      ))}
                    </select>
                    <button
                      onClick={async () => {
                        try {
                          const r = await apiClient.get('/config/avatar/templates', { params: { page: 1, size: 50 } })
                          if (r.data.success) {
                            setAvatarTemplates(r.data.templates || [])
                            alert(`✅ 已加载 ${r.data.templates.length} 个模板${r.data.templates.length === 0 ? '\n\n（提示：账号下还没有播报模板，需先到视频创作工作台创建）' : ''}`)
                          } else {
                            alert(`❌ 拉取失败：${r.data.error || '未知错误'}`)
                          }
                        } catch (err: any) {
                          alert(`❌ 网络错误：${err.message}`)
                        }
                      }}
                      style={{ ...buttonStyle, background: '#6366f1', padding: '8px 16px', whiteSpace: 'nowrap' }}
                    >🔄 拉取模板</button>
                  </div>
                  <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.5)', marginTop: '4px' }}>
                    路径：阿里云控制台 → 视频创作工作台 → 我的视频 → 对应视频模板的「复制 ID」
                  </div>
                </div>

                {/* 模板变量预览（点击「测试连接」后填充） */}
                {templateVariables.length > 0 && (
                  <div style={{ background: 'rgba(99, 102, 241, 0.08)', border: '1px solid rgba(99, 102, 241, 0.25)', borderRadius: '8px', padding: '12px' }}>
                    <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.7)', marginBottom: '8px', fontWeight: 600 }}>
                      📝 模板动态变量（{templateVariables.length} 个）
                    </div>
                    {templateVariables.map(v => (
                      <div key={v.name} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', padding: '4px 0' }}>
                        <span style={{ color: '#8b5cf6', fontWeight: 600, minWidth: '120px' }}>{v.name}</span>
                        <span style={{ background: v.type === 'text' ? 'rgba(16,185,129,0.2)' : 'rgba(245,158,11,0.2)', color: v.type === 'text' ? '#10b981' : '#f59e0b', padding: '2px 8px', borderRadius: '4px', fontSize: '11px' }}>{v.type}</span>
                        {v.type !== 'text' && <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: '11px' }}>需在模板里绑定</span>}
                      </div>
                    ))}
                  </div>
                )}

                <div style={{ background: 'rgba(99, 102, 241, 0.1)', border: '1px solid rgba(99, 102, 241, 0.25)', borderRadius: '8px', padding: '10px', fontSize: '12px', color: 'rgba(255,255,255,0.7)' }}>
                  💡 <strong>播报视频合成方案</strong>：后端调用阿里云异步合成视频，返回视频 URL，前端直接展示。无需实时交互服务。
                </div>
              </>
            )}

            {/* ===== 方案 B：Simli P2P（实时数字人） ===== */}
            {avatarConfig.provider === 'simli' && (
              <>
                <div>
                  <label style={labelStyle}>
                    ① Simli API Key
                    {avatarConfig.simli_api_key && <span style={{ color: '#10b981', fontSize: '11px', marginLeft: '8px' }}>✓ 已配置</span>}
                  </label>
                  {renderSecretInput('simli_api_key', avatarConfig.simli_api_key,
                    v => setAvatarConfig({ ...avatarConfig, simli_api_key: v }),
                    'simli_xxxx...（https://www.simli.com/ Profile 页获取）')}
                  <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.5)', marginTop: '4px' }}>
                    注册 https://www.simli.com/ → Profile → API Key
                  </div>
                </div>

                <div>
                  <label style={labelStyle}>
                    ② Simli Face ID
                    {avatarConfig.simli_face_id && <span style={{ color: '#10b981', fontSize: '11px', marginLeft: '8px' }}>✓ 已配置</span>}
                  </label>
                  <input
                    type="text"
                    value={avatarConfig.simli_face_id}
                    onChange={e => setAvatarConfig({ ...avatarConfig, simli_face_id: e.target.value })}
                    placeholder="例如：c5a4f6e8-...（https://www.simli.com/characters 选一个）"
                    style={{ ...inputStyle, fontFamily: 'monospace' }}
                  />
                  <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.5)', marginTop: '4px' }}>
                    路径：https://www.simli.com/characters → 选一个角色 → 复制 Face ID
                  </div>
                </div>

                <div style={{ background: 'rgba(168, 85, 247, 0.1)', border: '1px solid rgba(168, 85, 247, 0.25)', borderRadius: '8px', padding: '12px', fontSize: '12px', color: 'rgba(255,255,255,0.8)' }}>
                  💡 <strong>实时数字人方案</strong>：<br />
                  1. 在前端 <code style={{ background: 'rgba(0,0,0,0.3)', padding: '2px 6px', borderRadius: '3px' }}>backend/avatar_agents/simli_agent.py</code> 启动 LiveKit agent worker<br />
                  2. 文档：<a href="https://docs.simli.com/overview" target="_blank" style={{ color: '#60a5fa' }}>docs.simli.com</a><br />
                  3. 本页「测试连接」仅校验 API Key 能否访问 Simli gateway；实际 WebRTC 连接在 LiveKit worker 里建立
                </div>
              </>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <input type="checkbox" id="enable_avatar" checked={avatarConfig.enable_avatar} onChange={e => setAvatarConfig({ ...avatarConfig, enable_avatar: e.target.checked })} style={{ width: '16px', height: '16px' }} />
              <label htmlFor="enable_avatar" style={{ ...labelStyle, marginBottom: 0, cursor: 'pointer' }}>启用数字人功能</label>
            </div>
          </div>

          <div style={{ display: 'flex', gap: '12px', marginTop: '16px' }}>
            <button onClick={async () => {
              const cleanConfig = stripMeta(avatarConfig)
              await handleSave('avatar', cleanConfig)
              // 保存后自动跑一次测试，拿到 variables
              try {
                const r = await apiClient.post('/config/avatar/test', { config: cleanConfig })
                const data = r.data
                if (data.success) {
                  setTemplateVariables(data.variables || [])
                  setTestResults(prev => ({
                    ...prev,
                    avatar: { success: true, message: `✅ 模板「${data.template_name}」有效，包含 ${(data.variables || []).length} 个变量` }
                  }))
                } else {
                  setTestResults(prev => ({
                    ...prev,
                    avatar: { success: false, message: `❌ ${data.error}` }
                  }))
                }
              } catch (err: any) {
                setTestResults(prev => ({
                  ...prev,
                  avatar: { success: false, message: `❌ 网络错误：${err.message}` }
                }))
              }
            }} disabled={saving.avatar} style={{ ...buttonStyle, background: saving.avatar ? '#6b7280' : '#10b981' }}>
              {saving.avatar ? '保存中...' : '💾 保存配置'}
            </button>
            <button onClick={async () => {
              try {
                const r = await apiClient.post('/config/avatar/test', { config: stripMeta(avatarConfig) })
                const data = r.data
                if (data.success) {
                  setTemplateVariables(data.variables || [])
                  setTestResults(prev => ({
                    ...prev,
                    avatar: { success: true, message: `✅ 模板「${data.template_name || data.template_id}」可访问\n变量：${(data.variables || []).map((v: any) => `${v.name}(${v.type})`).join(', ') || '无'}` }
                  }))
                } else {
                  setTestResults(prev => ({
                    ...prev,
                    avatar: { success: false, message: `❌ ${data.error || '测试失败'}` }
                  }))
                }
              } catch (err: any) {
                setTestResults(prev => ({
                  ...prev,
                  avatar: { success: false, message: `❌ 网络错误：${err.message}` }
                }))
              }
            }} style={{ ...buttonStyle, background: '#3b82f6' }}>
              🧪 测试连接
            </button>
          </div>

          {testResults.avatar && (
            <div style={{ marginTop: '12px', padding: '12px', borderRadius: '6px', background: testResults.avatar.success ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)', color: testResults.avatar.success ? '#6ee7b7' : '#fca5a5', fontSize: '13px', whiteSpace: 'pre-wrap' }}>
              {testResults.avatar.message}
            </div>
          )}
        </div>
      </div>

      {/* 底部说明 */}
      <div style={{ marginTop: '32px', textAlign: 'center', color: 'rgba(255,255,255,0.5)', fontSize: '13px' }}>
        ✅ 配置保存在后端，重启后依然有效 | 📝 修改后记得点击「保存配置」
      </div>
    </div>
  )
}

export default SettingsPage
