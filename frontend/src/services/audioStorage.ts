/**
 * 浏览器端音频本地存储（IndexedDB）
 *
 * 为什么用 IndexedDB 而非 localStorage？
 *   - localStorage 单 key 限制 ~5MB，mp3 文件会爆
 *   - IndexedDB 容量大（通常 50MB+），可以存 blob
 *
 * 数据模型：
 *   database: avatar_audio_cache
 *   store:     audio_files
 *   key:       messageId
 *   value:     { messageId, role, text, audioBlob, mimeType, createdAt }
 */

const DB_NAME = 'avatar_audio_cache'
const DB_VERSION = 1
const STORE_NAME = 'audio_files'

interface AudioRecord {
  messageId: string
  role: 'user' | 'assistant'
  text: string
  audioBlob: Blob
  mimeType: string
  createdAt: number
}

let _dbPromise: Promise<IDBDatabase> | null = null

function openDB(): Promise<IDBDatabase> {
  if (_dbPromise) return _dbPromise
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'messageId' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return _dbPromise
}

/**
 * 把 base64 mp3 字符串存进 IndexedDB
 * 返回该记录的对象 URL（可直接给 <audio src=...> 用）
 */
export async function saveAudioFromBase64(
  messageId: string,
  role: 'user' | 'assistant',
  text: string,
  mp3Base64: string
): Promise<{ url: string; blob: Blob }> {
  // base64 → bytes → blob
  const binaryStr = atob(mp3Base64)
  const bytes = new Uint8Array(binaryStr.length)
  for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i)
  const blob = new Blob([bytes], { type: 'audio/mpeg' })

  return saveAudioBlob(messageId, role, text, blob)
}

export async function saveAudioBlob(
  messageId: string,
  role: 'user' | 'assistant',
  text: string,
  blob: Blob
): Promise<{ url: string; blob: Blob }> {
  const db = await openDB()
  const record: AudioRecord = {
    messageId,
    role,
    text,
    audioBlob: blob,
    mimeType: blob.type || 'audio/mpeg',
    createdAt: Date.now(),
  }
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).put(record)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  // 给前端用
  const url = URL.createObjectURL(blob)
  console.log(
    `[audioStorage] saved: msg=${messageId.slice(-8)} role=${role} size=${blob.size} bytes url=${url.slice(-20)}`
  )
  return { url, blob }
}

/**
 * 从 IndexedDB 读音频，返回 { url, blob } 或 null
 */
export async function loadAudio(messageId: string): Promise<{ url: string; blob: Blob; record: AudioRecord } | null> {
  try {
    const db = await openDB()
    const record = await new Promise<AudioRecord | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const req = tx.objectStore(STORE_NAME).get(messageId)
      req.onsuccess = () => resolve(req.result as AudioRecord | undefined)
      req.onerror = () => reject(req.error)
    })
    if (!record) return null
    const url = URL.createObjectURL(record.audioBlob)
    return { url, blob: record.audioBlob, record }
  } catch (e) {
    console.warn('[audioStorage] load failed:', e)
    return null
  }
}

export async function deleteAudio(messageId: string): Promise<void> {
  const db = await openDB()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).delete(messageId)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function listAllAudio(): Promise<AudioRecord[]> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const req = tx.objectStore(STORE_NAME).getAll()
    req.onsuccess = () => resolve(req.result as AudioRecord[])
    req.onerror = () => reject(req.error)
  })
}

/**
 * base64 mp3 字符串 → Object URL（不存到 IndexedDB，只为临时使用）
 */
export function base64ToObjectUrl(mp3Base64: string, mimeType = 'audio/mpeg'): string {
  const binaryStr = atob(mp3Base64)
  const bytes = new Uint8Array(binaryStr.length)
  for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i)
  const blob = new Blob([bytes], { type: mimeType })
  return URL.createObjectURL(blob)
}

/**
 * 释放 Object URL，避免内存泄漏
 */
export function revokeObjectUrl(url: string): void {
  if (url && url.startsWith('blob:')) {
    URL.revokeObjectURL(url)
  }
}

export type { AudioRecord }
