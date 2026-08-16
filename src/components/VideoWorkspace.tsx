import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  createVideoTask,
  downloadVideoContent,
  fetchVideoCatalog,
  fetchVideoTask,
  getVideoContentUrl,
  getVideoTaskError,
  normalizeVideoProgress,
  normalizeVideoTaskStatus,
  type VideoModelCapabilities,
} from '../lib/videoApi'
import { getAudioDuration, getVideoDuration } from '../lib/videoDuration'
import { uploadR2Asset } from '../lib/r2AssetUpload'
import { ensureWorkspaceConversation, syncWorkspaceConversationStats, touchWorkspaceConversation } from '../lib/workspaceConversations'
import { readVideoConversationDrafts, VIDEO_TASKS_KEY as TASKS_KEY, writeVideoConversationDraft, type VideoConversationDraft } from '../lib/videoWorkspaceStorage'
import { useWorkspaceConversations } from '../hooks/useWorkspaceConversations'
import { ArrowDownIcon, DownloadIcon, PlusIcon, RefreshIcon, SettingsIcon, TrashIcon } from './icons'

type VideoTaskStatus = 'submitting' | 'queued' | 'processing' | 'completed' | 'failed'

interface VideoTaskRecord {
  id: string
  workspaceConversationId: string
  publicTaskId?: string
  videoUrl?: string
  prompt: string
  model: string
  aspectRatio: string
  duration: number
  resolution: string
  generateAudio: boolean
  imageUrls: string[]
  referenceVideo: string
  audioUrls?: string[]
  status: VideoTaskStatus
  progress: number
  error?: string
  createdAt: number
  updatedAt: number
}

interface VideoConfig {
  apiKey: string
  model: string
  aspectRatio: string
  duration: number
  resolution: string
  generateAudio: boolean
  count: number
}

const CONFIG_KEY = 'gpt-image-playground-video-config-v1'
const CATALOG_KEY = 'gpt-image-playground-video-catalog-v1'
const VIDEO_API_BASE_URL = 'https://video-admin.yyapi.cloud/new-api'
const VIDEO_CAPABILITIES_BASE_URL = 'https://video-admin.yyapi.cloud'
const DEFAULT_CONFIG: VideoConfig = {
  apiKey: '',
  model: '',
  aspectRatio: '16:9',
  duration: 8,
  resolution: '720p',
  generateAudio: true,
  count: 1,
}
const DEFAULT_CAPABILITIES: VideoModelCapabilities = {
  ratios: ['16:9', '9:16'],
  durations: [4, 6, 8, 10],
  resolutions: ['720p', '1080p'],
  maxImages: 5,
  referenceVideo: false,
  experimental: true,
}
const FALLBACK_MODEL_CAPABILITIES: Record<string, VideoModelCapabilities> = {
  'gemini-omni-flash': { ratios: ['16:9', '9:16'], durations: [4, 6, 8, 10], resolutions: ['720p'], maxImages: 5, referenceVideo: true },
  sora2: { ratios: ['16:9', '9:16'], durations: [4, 8, 12], resolutions: ['720p'], maxImages: 1, referenceVideo: false, experimental: true },
  'veo31-fast': { ratios: ['16:9', '9:16'], durations: [4, 6, 8], resolutions: ['720p', '1080p'], maxImages: 2, referenceVideo: false, experimental: true },
  'manxue-933': { ratios: ['16:9', '9:16', '4:3', '3:4', '1:1', '21:9'], durations: [15], resolutions: ['720p'], maxImages: 9, referenceVideo: true, maxAudios: 3, maxReferences: 12, minReferenceVideoDuration: 2, maxReferenceVideoDuration: 15, minAudioDuration: 2, maxAudioDuration: 15, maxTotalAudioDuration: 15, experimental: true },
  'manxue-900': { ratios: ['16:9', '9:16', '4:3', '3:4', '1:1', '21:9'], durations: Array.from({ length: 11 }, (_, idx) => idx + 5), resolutions: ['720p'], maxImages: 9, referenceVideo: false, experimental: true },
  'grok-imagine-1.0-video': { ratios: ['自动'], durations: [0], resolutions: ['自动'], maxImages: 0, referenceVideo: false, experimental: true },
  'grok-imagine-video-1.5-fast': { ratios: ['16:9', '9:16'], durations: [10], resolutions: ['720p'], maxImages: 5, referenceVideo: false, experimental: true },
  'grok-imagine-video-1.5-preview': { ratios: ['自动'], durations: [0], resolutions: ['自动'], maxImages: 0, referenceVideo: false, experimental: true },
}

function readJson(key: string): unknown {
  try {
    const value = localStorage.getItem(key)
    return value ? JSON.parse(value) : null
  } catch {
    return null
  }
}

function readConfig(): VideoConfig {
  const value = readJson(CONFIG_KEY)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return DEFAULT_CONFIG
  const config = value as Partial<VideoConfig>
  return {
    apiKey: typeof config.apiKey === 'string' ? config.apiKey : '',
    model: typeof config.model === 'string' ? config.model : '',
    aspectRatio: typeof config.aspectRatio === 'string' ? config.aspectRatio : DEFAULT_CONFIG.aspectRatio,
    duration: typeof config.duration === 'number' ? config.duration : DEFAULT_CONFIG.duration,
    resolution: typeof config.resolution === 'string' ? config.resolution : DEFAULT_CONFIG.resolution,
    generateAudio: true,
    count: [1, 2, 3, 4].includes(config.count ?? 0) ? config.count! : 1,
  }
}

function readTasks() {
  const value = readJson(TASKS_KEY)
  if (!Array.isArray(value)) return []
  const tasks = value.filter((task): task is VideoTaskRecord => Boolean(
    task &&
    typeof task === 'object' &&
    typeof task.id === 'string' &&
    typeof task.prompt === 'string' &&
    typeof task.model === 'string' &&
    typeof task.status === 'string' &&
    typeof task.createdAt === 'number',
  ))
  const conversationId = ensureWorkspaceConversation('video', tasks.length ? '历史视频' : '新对话')
  return tasks.map((task) => typeof task.workspaceConversationId === 'string' ? task : { ...task, workspaceConversationId: conversationId })
}

function readCatalog() {
  const value = readJson(CATALOG_KEY)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const catalog = value as { models?: unknown; capabilities?: unknown }
  if (!Array.isArray(catalog.models) || !catalog.models.every((model) => typeof model === 'string')) return null
  if (!catalog.capabilities || typeof catalog.capabilities !== 'object' || Array.isArray(catalog.capabilities)) return null
  const capabilities = catalog.capabilities as Record<string, Partial<VideoModelCapabilities>>
  if (!Object.values(capabilities).every((item) => (
    Array.isArray(item.ratios) && item.ratios.every((ratio) => typeof ratio === 'string') &&
    Array.isArray(item.durations) && item.durations.every((duration) => typeof duration === 'number') &&
    Array.isArray(item.resolutions) && item.resolutions.every((resolution) => typeof resolution === 'string') &&
    typeof item.maxImages === 'number' && typeof item.referenceVideo === 'boolean'
  ))) return null
  return {
    models: catalog.models,
    capabilities: capabilities as Record<string, VideoModelCapabilities>,
  }
}

function getStatusLabel(status: VideoTaskStatus) {
  if (status === 'submitting') return '正在提交'
  if (status === 'queued') return '排队中'
  if (status === 'processing') return '生成中'
  if (status === 'completed') return '已完成'
  return '失败'
}

function getElapsed(createdAt: number, updatedAt: number) {
  const seconds = Math.max(0, Math.round((updatedAt - createdAt) / 1000))
  const minutes = Math.floor(seconds / 60)
  return minutes ? `${minutes}:${String(seconds % 60).padStart(2, '0')}` : `${seconds}s`
}

function isPublicUrl(value: string) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

export default function VideoWorkspace() {
  const workspaceState = useWorkspaceConversations()
  const activeConversationId = workspaceState.activeIds.video
  const cachedCatalog = useMemo(readCatalog, [])
  const [config, setConfig] = useState<VideoConfig>(readConfig)
  const [tasks, setTasks] = useState<VideoTaskRecord[]>(readTasks)
  const [models, setModels] = useState<string[]>(cachedCatalog?.models ?? [])
  const [modelCapabilities, setModelCapabilities] = useState({
    ...FALLBACK_MODEL_CAPABILITIES,
    ...cachedCatalog?.capabilities,
  })
  const initialDraft = useMemo(() => activeConversationId ? readVideoConversationDrafts()[activeConversationId] : null, [])
  const [prompt, setPrompt] = useState(initialDraft?.prompt ?? '')
  const [imageUrlText, setImageUrlText] = useState(initialDraft?.imageUrlText ?? '')
  const [referenceVideo, setReferenceVideo] = useState(initialDraft?.referenceVideo ?? '')
  const [audioUrlText, setAudioUrlText] = useState(initialDraft?.audioUrlText ?? '')
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'all' | 'running' | 'completed' | 'failed'>('all')
  const [showConfig, setShowConfig] = useState(false)
  const [showAssets, setShowAssets] = useState(false)
  const [promptFocused, setPromptFocused] = useState(false)
  const [loadingModels, setLoadingModels] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [uploadingAsset, setUploadingAsset] = useState<'image' | 'video' | 'audio' | null>(null)
  const [message, setMessage] = useState<{ text: string; type: 'error' | 'success' } | null>(null)
  const [videoPreview, setVideoPreview] = useState<{ taskId: string; url: string } | null>(null)
  const [loadingPreviewTaskId, setLoadingPreviewTaskId] = useState<string | null>(null)
  const [assetPreview, setAssetPreview] = useState<{ kind: 'image' | 'video' | 'audio'; url: string; title: string } | null>(null)
  const pollingRef = useRef(new Set<string>())
  const previewFallbackRef = useRef(new Set<string>())
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const activeConversationRef = useRef(activeConversationId)
  const deletedConversationIdsRef = useRef(new Set<string>())
  const draftRef = useRef<VideoConversationDraft>({ prompt, imageUrlText, referenceVideo, audioUrlText })
  const skipDraftPersistRef = useRef(false)
  const videoPreviewRef = useRef<{ taskId: string; url: string } | null>(null)
  const tasksRef = useRef<VideoTaskRecord[]>(tasks)

  const capabilities = modelCapabilities[config.model] ?? DEFAULT_CAPABILITIES
  const imageUrls = imageUrlText.split(/\r?\n|,/).map((url) => url.trim()).filter(Boolean)
  const audioUrls = audioUrlText.split(/\r?\n|,/).map((url) => url.trim()).filter(Boolean)
  const referenceCount = imageUrls.length + audioUrls.length + (referenceVideo ? 1 : 0)
  const referenceLimit = capabilities.maxReferences ?? capabilities.maxImages + (capabilities.referenceVideo ? 1 : 0) + (capabilities.maxAudios ?? 0)

  useEffect(() => {
    if (!activeConversationId || activeConversationRef.current === activeConversationId) return
    if (activeConversationRef.current && !deletedConversationIdsRef.current.has(activeConversationRef.current)) {
      writeVideoConversationDraft(activeConversationRef.current, draftRef.current)
    }
    if (activeConversationRef.current) deletedConversationIdsRef.current.delete(activeConversationRef.current)
    const draft = readVideoConversationDrafts()[activeConversationId]
    skipDraftPersistRef.current = true
    setPrompt(draft?.prompt ?? '')
    setImageUrlText(draft?.imageUrlText ?? '')
    setReferenceVideo(draft?.referenceVideo ?? '')
    setAudioUrlText(draft?.audioUrlText ?? '')
    setShowAssets(false)
    setShowConfig(false)
    if (videoPreviewRef.current?.url.startsWith('blob:')) URL.revokeObjectURL(videoPreviewRef.current.url)
    videoPreviewRef.current = null
    setVideoPreview(null)
    activeConversationRef.current = activeConversationId
  }, [activeConversationId])

  useEffect(() => {
    draftRef.current = { prompt, imageUrlText, referenceVideo, audioUrlText }
    if (!activeConversationId) return
    if (skipDraftPersistRef.current) {
      skipDraftPersistRef.current = false
      return
    }
    writeVideoConversationDraft(activeConversationId, draftRef.current)
  }, [activeConversationId, audioUrlText, imageUrlText, prompt, referenceVideo])

  const uploadAssets = async (files: File[], kind: 'image' | 'video' | 'audio') => {
    if (!files.length) return
    if (kind === 'image' && imageUrls.length + files.length > capabilities.maxImages) {
      setMessage({ text: `当前还能上传 ${Math.max(0, capabilities.maxImages - imageUrls.length)} 张参考图`, type: 'error' })
      return
    }
    if (kind === 'video' && !capabilities.referenceVideo) {
      setMessage({ text: '当前模型不支持参考视频', type: 'error' })
      return
    }
    if (kind === 'audio' && (!capabilities.maxAudios || audioUrls.length + files.length > capabilities.maxAudios)) {
      setMessage({ text: capabilities.maxAudios ? `当前模型最多支持 ${capabilities.maxAudios} 个参考音频` : '当前模型不支持参考音频', type: 'error' })
      return
    }
    if (capabilities.maxReferences && imageUrls.length + audioUrls.length + (referenceVideo ? 1 : 0) + files.length > capabilities.maxReferences) {
      setMessage({ text: `当前模型的图片、视频和音频合计不能超过 ${capabilities.maxReferences} 个`, type: 'error' })
      return
    }

    setMessage(null)
    setUploadingAsset(kind)
    try {
      if (kind === 'video') {
        const duration = await getVideoDuration(files[0])
        const minDuration = capabilities.minReferenceVideoDuration ?? 0
        const maxDuration = capabilities.maxReferenceVideoDuration ?? 30
        if (duration > maxDuration || duration < minDuration) {
          setMessage({ text: `参考视频时长为 ${duration.toFixed(1)} 秒，必须在 ${minDuration}–${maxDuration} 秒内`, type: 'error' })
          return
        }
      }
      if (kind === 'audio') {
        const newDurations = await Promise.all(files.map((file) => getAudioDuration(file)))
        const minDuration = capabilities.minAudioDuration ?? 2
        const maxDuration = capabilities.maxAudioDuration ?? 15
        const invalidDuration = newDurations.find((duration) => duration < minDuration || duration > maxDuration)
        if (invalidDuration !== undefined) {
          setMessage({ text: `参考音频时长为 ${invalidDuration.toFixed(1)} 秒，必须在 ${minDuration}–${maxDuration} 秒内`, type: 'error' })
          return
        }
        const existingDurations = await Promise.all(audioUrls.map((url) => getAudioDuration(url)))
        const totalDuration = [...existingDurations, ...newDurations].reduce((sum, duration) => sum + duration, 0)
        const maxTotalDuration = capabilities.maxTotalAudioDuration ?? 15
        if (totalDuration > maxTotalDuration) {
          setMessage({ text: `参考音频总时长为 ${totalDuration.toFixed(1)} 秒，不能超过 ${maxTotalDuration} 秒`, type: 'error' })
          return
        }
      }
      for (const file of files) {
        const url = await uploadR2Asset(file)
        if (kind === 'image') setImageUrlText((current) => [...current.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean), url].join('\n'))
        else if (kind === 'video') setReferenceVideo(url)
        else setAudioUrlText((current) => [...current.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean), url].join('\n'))
      }
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : '上传失败', type: 'error' })
    } finally {
      setUploadingAsset(null)
    }
  }

  useEffect(() => {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config))
  }, [config])

  useEffect(() => {
    localStorage.setItem(TASKS_KEY, JSON.stringify(tasks))
    tasksRef.current = tasks
    const stats: Record<string, { taskCount: number; updatedAt: number }> = {}
    for (const task of tasks) {
      const current = stats[task.workspaceConversationId]
      stats[task.workspaceConversationId] = {
        taskCount: (current?.taskCount ?? 0) + 1,
        updatedAt: Math.max(current?.updatedAt ?? 0, task.updatedAt),
      }
    }
    syncWorkspaceConversationStats('video', stats)
  }, [tasks])

  useEffect(() => {
    const handleConversationDeleted = (event: Event) => {
      const id = (event as CustomEvent<string>).detail
      if (id === '__all__') {
        for (const task of tasksRef.current) deletedConversationIdsRef.current.add(task.workspaceConversationId)
        setTasks([])
        return
      }
      deletedConversationIdsRef.current.add(id)
      setTasks((current) => current.filter((task) => task.workspaceConversationId !== id))
    }
    window.addEventListener('workspace-video-conversation-deleted', handleConversationDeleted)
    return () => window.removeEventListener('workspace-video-conversation-deleted', handleConversationDeleted)
  }, [])

  useEffect(() => {
    videoPreviewRef.current = videoPreview
  }, [videoPreview])

  useEffect(() => () => {
    if (videoPreviewRef.current?.url.startsWith('blob:')) URL.revokeObjectURL(videoPreviewRef.current.url)
  }, [])

  useEffect(() => {
    if (!assetPreview) return
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAssetPreview(null)
    }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [assetPreview])

  const updateTask = useCallback((id: string, patch: Partial<VideoTaskRecord>) => {
    setTasks((current) => current.map((task) => task.id === id ? { ...task, ...patch, updatedAt: Date.now() } : task))
  }, [])

  const loadPreview = useCallback(async (task: VideoTaskRecord) => {
    if (!task.publicTaskId || videoPreviewRef.current?.taskId === task.id || loadingPreviewTaskId) return
    setLoadingPreviewTaskId(task.id)
    setMessage(null)
    let streaming = false
    try {
      const savedPublicUrl = getVideoContentUrl({ video_url: task.videoUrl })
      const latest = savedPublicUrl ? null : await fetchVideoTask(VIDEO_API_BASE_URL, config.apiKey, task.publicTaskId)
      const publicUrl = savedPublicUrl || (latest ? getVideoContentUrl(latest) : undefined)
      const url = publicUrl || URL.createObjectURL((await downloadVideoContent(VIDEO_API_BASE_URL, config.apiKey, task.publicTaskId)).blob)
      streaming = Boolean(publicUrl)
      if (publicUrl !== task.videoUrl) updateTask(task.id, { videoUrl: publicUrl })
      if (videoPreviewRef.current?.url.startsWith('blob:')) URL.revokeObjectURL(videoPreviewRef.current.url)
      const preview = { taskId: task.id, url }
      videoPreviewRef.current = preview
      setVideoPreview(preview)
    } finally {
      if (!streaming) setLoadingPreviewTaskId(null)
    }
  }, [config.apiKey, loadingPreviewTaskId, updateTask])

  const handlePreviewError = useCallback(async (task: VideoTaskRecord) => {
    const failedPreview = videoPreviewRef.current
    if (!task.publicTaskId || !failedPreview || failedPreview.taskId !== task.id) return
    if (failedPreview.url.startsWith('blob:')) {
      URL.revokeObjectURL(failedPreview.url)
      videoPreviewRef.current = null
      setVideoPreview(null)
      setLoadingPreviewTaskId(null)
      setMessage({ text: '当前浏览器无法播放该视频编码，请下载后查看', type: 'error' })
      return
    }
    if (previewFallbackRef.current.has(task.id)) return

    previewFallbackRef.current.add(task.id)
    setLoadingPreviewTaskId(task.id)
    try {
      const result = await downloadVideoContent(VIDEO_API_BASE_URL, config.apiKey, task.publicTaskId)
      const url = URL.createObjectURL(result.blob)
      if (videoPreviewRef.current !== failedPreview) {
        URL.revokeObjectURL(url)
        return
      }
      const preview = { taskId: task.id, url }
      videoPreviewRef.current = preview
      setVideoPreview(preview)
    } catch (err) {
      if (videoPreviewRef.current !== failedPreview) return
      videoPreviewRef.current = null
      setVideoPreview(null)
      setLoadingPreviewTaskId(null)
      setMessage({ text: err instanceof Error ? `视频预览加载失败：${err.message}` : '视频预览加载失败', type: 'error' })
    } finally {
      previewFallbackRef.current.delete(task.id)
    }
  }, [config.apiKey])

  const pollTask = useCallback(async (task: VideoTaskRecord) => {
    if (!task.publicTaskId || pollingRef.current.has(task.id)) return
    pollingRef.current.add(task.id)
    try {
      const result = await fetchVideoTask(VIDEO_API_BASE_URL, config.apiKey, task.publicTaskId)
      const status = normalizeVideoTaskStatus(result.status)
      const progress = normalizeVideoProgress(result.progress, task.progress)
      if (status === 'completed') {
        const completed = { ...task, status: 'completed' as const, progress: 100, videoUrl: getVideoContentUrl(result) || task.videoUrl, updatedAt: Date.now() }
        updateTask(task.id, completed)
      } else if (status === 'failed') {
        updateTask(task.id, { status: 'failed', progress, error: getVideoTaskError(result) })
      } else {
        updateTask(task.id, { status, progress })
      }
    } catch (err) {
      console.warn('Video task polling failed:', err)
    } finally {
      pollingRef.current.delete(task.id)
    }
  }, [config.apiKey, updateTask])

  useEffect(() => {
    const recover = () => {
      for (const task of tasksRef.current) {
        if (task.status === 'queued' || task.status === 'processing') void pollTask(task)
      }
    }
    recover()
    const timer = window.setInterval(recover, 12_000)
    return () => window.clearInterval(timer)
  }, [pollTask])

  const loadModels = useCallback(async () => {
    setLoadingModels(true)
    try {
      const { models: ids, capabilities: remoteCapabilities } = await fetchVideoCatalog(VIDEO_CAPABILITIES_BASE_URL)
      if (!ids.length) throw new Error('中间件没有返回可用模型')
      const capabilitiesByModel = Object.fromEntries(remoteCapabilities.map((item) => [item.id, item.capabilities]))
      const mergedCapabilities = {
        ...FALLBACK_MODEL_CAPABILITIES,
        ...capabilitiesByModel,
      }
      localStorage.setItem(CATALOG_KEY, JSON.stringify({
        models: ids,
        capabilities: capabilitiesByModel,
        updatedAt: Date.now(),
      }))
      setModels(ids)
      setModelCapabilities(mergedCapabilities)
      if (!ids.includes(config.model)) setConfig((current) => ({ ...current, model: ids[0] }))
      setMessage({ text: `已同步 ${ids.length} 个模型`, type: 'success' })
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : '模型列表加载失败', type: 'error' })
    } finally {
      setLoadingModels(false)
    }
  }, [config.model])

  useEffect(() => {
    const next = modelCapabilities[config.model] ?? DEFAULT_CAPABILITIES
    if (!next.referenceVideo) setReferenceVideo('')
    if (!next.maxAudios) setAudioUrlText('')
    setConfig((current) => ({
      ...current,
      aspectRatio: next.ratios.includes(current.aspectRatio) ? current.aspectRatio : next.ratios[0],
      duration: next.durations.includes(current.duration) ? current.duration : next.durations[0],
      resolution: next.resolutions.includes(current.resolution) ? current.resolution : next.resolutions[0],
    }))
  }, [config.model, modelCapabilities])

  const submit = async () => {
    if (!config.apiKey.trim()) {
      setShowConfig(true)
      setMessage({ text: '请先填写视频接口 API Key', type: 'error' })
      return
    }
    if (!config.model) {
      setMessage({ text: '请先同步并选择视频模型', type: 'error' })
      return
    }
    if (!prompt.trim()) {
      setMessage({ text: '请输入视频提示词', type: 'error' })
      return
    }
    if (/(?:\d+(?:\.\d+)?\s*(?:秒|s\b))|(?:\d+\s*:\s*\d+)/i.test(prompt)) {
      setMessage({ text: '提示词中不要填写时长、时间码或画面比例，请使用下方参数', type: 'error' })
      return
    }
    if (imageUrls.some((url) => !isPublicUrl(url)) || audioUrls.some((url) => !isPublicUrl(url)) || (referenceVideo && !isPublicUrl(referenceVideo))) {
      setMessage({ text: '参考素材必须是可公开访问的 HTTP/HTTPS URL', type: 'error' })
      return
    }
    if (imageUrls.length > capabilities.maxImages) {
      setMessage({ text: `当前模型最多支持 ${capabilities.maxImages} 张参考图`, type: 'error' })
      return
    }
    if (audioUrls.length > (capabilities.maxAudios ?? 0)) {
      setMessage({ text: `当前模型最多支持 ${capabilities.maxAudios ?? 0} 个参考音频`, type: 'error' })
      return
    }
    if (capabilities.maxReferences && imageUrls.length + audioUrls.length + (referenceVideo ? 1 : 0) > capabilities.maxReferences) {
      setMessage({ text: `当前模型的图片、视频和音频合计不能超过 ${capabilities.maxReferences} 个`, type: 'error' })
      return
    }

    if (referenceVideo) {
      setSubmitting(true)
      try {
        const duration = await getVideoDuration(referenceVideo)
        const minDuration = capabilities.minReferenceVideoDuration ?? 0
        const maxDuration = capabilities.maxReferenceVideoDuration ?? 30
        if (duration > maxDuration || duration < minDuration) {
          setMessage({ text: `参考视频时长为 ${duration.toFixed(1)} 秒，必须在 ${minDuration}–${maxDuration} 秒内`, type: 'error' })
          setSubmitting(false)
          return
        }
      } catch (err) {
        setMessage({ text: err instanceof Error ? err.message : '无法读取参考视频时长', type: 'error' })
        setSubmitting(false)
        return
      }
    }

    if (audioUrls.length) {
      setSubmitting(true)
      try {
        const durations = await Promise.all(audioUrls.map((url) => getAudioDuration(url)))
        const minDuration = capabilities.minAudioDuration ?? 2
        const maxDuration = capabilities.maxAudioDuration ?? 15
        const invalidDuration = durations.find((duration) => duration < minDuration || duration > maxDuration)
        if (invalidDuration !== undefined) {
          setMessage({ text: `参考音频时长为 ${invalidDuration.toFixed(1)} 秒，单个音频必须在 ${minDuration}–${maxDuration} 秒内`, type: 'error' })
          setSubmitting(false)
          return
        }
        const totalDuration = durations.reduce((sum, duration) => sum + duration, 0)
        const maxTotalDuration = capabilities.maxTotalAudioDuration ?? 15
        if (totalDuration > maxTotalDuration) {
          setMessage({ text: `参考音频总时长为 ${totalDuration.toFixed(1)} 秒，不能超过 ${maxTotalDuration} 秒`, type: 'error' })
          setSubmitting(false)
          return
        }
      } catch (err) {
        setMessage({ text: err instanceof Error ? err.message : '无法读取参考音频时长', type: 'error' })
        setSubmitting(false)
        return
      }
    }

    setSubmitting(true)
    setMessage(null)
    for (let idx = 0; idx < config.count; idx++) {
      if (activeConversationId && deletedConversationIdsRef.current.has(activeConversationId)) break
      const now = Date.now()
      const localId = crypto.randomUUID()
      const draft: VideoTaskRecord = {
        id: localId,
        workspaceConversationId: activeConversationId ?? ensureWorkspaceConversation('video'),
        prompt: prompt.trim(),
        model: config.model,
        aspectRatio: config.aspectRatio,
        duration: config.duration,
        resolution: config.resolution,
        generateAudio: true,
        imageUrls,
        referenceVideo,
        audioUrls,
        status: 'submitting',
        progress: 0,
        createdAt: now,
        updatedAt: now,
      }
      setTasks((current) => [draft, ...current])
      try {
        const result = await createVideoTask(VIDEO_API_BASE_URL, config.apiKey.trim(), {
          model: config.model,
          prompt: draft.prompt,
          aspectRatio: config.aspectRatio === '自动' ? undefined : config.aspectRatio,
          duration: config.duration || undefined,
          resolution: config.resolution === '自动' ? undefined : config.resolution,
          generateAudio: true,
          imageUrls,
          referenceVideo: referenceVideo || undefined,
          audioUrls: audioUrls.length ? audioUrls : undefined,
        })
        updateTask(localId, {
          publicTaskId: result.taskId,
          videoUrl: getVideoContentUrl(result.task),
          status: normalizeVideoTaskStatus(result.task.status),
          progress: normalizeVideoProgress(result.task.progress),
          error: normalizeVideoTaskStatus(result.task.status) === 'failed' ? getVideoTaskError(result.task) : undefined,
        })
        touchWorkspaceConversation(draft.workspaceConversationId, draft.prompt)
      } catch (err) {
        updateTask(localId, { status: 'failed', error: err instanceof Error ? err.message : '创建任务失败' })
      }
    }
    setSubmitting(false)
    setPrompt('')
    promptRef.current?.blur()
    setPromptFocused(false)
  }

  const remove = async (task: VideoTaskRecord) => {
    setTasks((current) => current.filter((item) => item.id !== task.id))
    if (videoPreviewRef.current?.taskId === task.id) {
      if (videoPreviewRef.current.url.startsWith('blob:')) URL.revokeObjectURL(videoPreviewRef.current.url)
      videoPreviewRef.current = null
      setVideoPreview(null)
    }
  }

  const retry = (task: VideoTaskRecord) => {
    setPrompt(task.prompt)
    setConfig((current) => ({
      ...current,
      model: task.model,
      aspectRatio: task.aspectRatio,
      duration: task.duration,
      resolution: task.resolution,
      generateAudio: true,
      count: 1,
    }))
    setImageUrlText(task.imageUrls.join('\n'))
    setReferenceVideo(task.referenceVideo)
    setAudioUrlText((task.audioUrls ?? []).join('\n'))
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' })
    window.requestAnimationFrame(() => promptRef.current?.focus())
  }

  const download = async (task: VideoTaskRecord) => {
    try {
      if (!task.publicTaskId) throw new Error('任务 ID 不存在')
      const result = await downloadVideoContent(VIDEO_API_BASE_URL, config.apiKey, task.publicTaskId, task.videoUrl)
      const url = URL.createObjectURL(result.blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `${task.model}-${task.publicTaskId}.${result.extension}`
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : '视频下载失败', type: 'error' })
    }
  }

  const filteredTasks = useMemo(() => tasks.filter((task) => {
    if (task.workspaceConversationId !== activeConversationId) return false
    if (filter === 'running' && !['submitting', 'queued', 'processing'].includes(task.status)) return false
    if (filter === 'completed' && task.status !== 'completed') return false
    if (filter === 'failed' && task.status !== 'failed') return false
    const query = search.trim().toLowerCase()
    return !query || task.prompt.toLowerCase().includes(query) || task.model.toLowerCase().includes(query) || task.publicTaskId?.toLowerCase().includes(query)
  }), [activeConversationId, filter, search, tasks])

  return (
    <>
      <main className={`safe-area-x mx-auto max-w-7xl transition-[padding] duration-200 ${showAssets || showConfig ? 'pb-[560px]' : promptFocused ? 'pb-[260px]' : 'pb-[180px]'}`}>
        <div className="flex flex-col gap-3 py-5 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <svg className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8" strokeWidth="2" /><path d="m21 21-4.3-4.3" strokeWidth="2" /></svg>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索提示词、模型或任务 ID" className="h-12 w-full rounded-xl border border-gray-200 bg-white pl-11 pr-4 text-sm outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-500/10 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-white" />
          </div>
          <div className="grid h-11 grid-cols-4 rounded-xl bg-gray-100 p-1 dark:bg-white/[0.05]">
            {([['all', '全部'], ['running', '进行中'], ['completed', '已完成'], ['failed', '失败']] as const).map(([value, label]) => (
              <button key={value} type="button" onClick={() => setFilter(value)} className={`min-w-[64px] rounded-lg px-3 text-xs transition ${filter === value ? 'bg-white font-medium text-gray-900 shadow-sm dark:bg-white/10 dark:text-white' : 'text-gray-500 dark:text-gray-400'}`}>{label}</button>
            ))}
          </div>
        </div>

        {filteredTasks.length ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {filteredTasks.map((task) => {
              const running = ['submitting', 'queued', 'processing'].includes(task.status)
              return (
                <article key={task.id} className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm transition hover:-translate-y-0.5 hover:shadow-md dark:border-white/[0.08] dark:bg-white/[0.035]">
                  <div className="relative aspect-video bg-gray-950">
                    {videoPreview?.taskId === task.id ? (
                      <>
                        <video
                          src={videoPreview.url}
                          controls
                          playsInline
                          preload="metadata"
                          onLoadedMetadata={() => setLoadingPreviewTaskId(null)}
                          onError={() => void handlePreviewError(task)}
                          className="h-full w-full object-contain"
                        />
                        {loadingPreviewTaskId === task.id && <div className="absolute inset-0 flex items-center justify-center bg-gray-950/70"><div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-700 border-t-blue-500" /></div>}
                      </>
                    ) : (
                      <div className="flex h-full flex-col items-center justify-center gap-3 text-gray-400">
                        {running ? <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-700 border-t-blue-500" /> : <svg className="h-10 w-10 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="m15 10 4.5-2.5a1 1 0 0 1 1.5.87v7.26a1 1 0 0 1-1.5.87L15 14M5 6h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z" strokeWidth="1.5" /></svg>}
                        <span className="text-xs">{getStatusLabel(task.status)}{running && task.progress ? ` ${task.progress}%` : ''}</span>
                        {task.status === 'completed' && <button type="button" disabled={loadingPreviewTaskId !== null} onClick={() => void loadPreview(task).catch((err) => setMessage({ text: err instanceof Error ? err.message : '视频预览加载失败', type: 'error' }))} className="rounded-lg bg-white/10 px-3 py-1.5 text-xs text-white transition hover:bg-white/20 disabled:cursor-wait disabled:opacity-70">{loadingPreviewTaskId === task.id ? '加载中…' : '加载预览'}</button>}
                      </div>
                    )}
                    <div className="absolute left-2 top-2 flex gap-1.5">
                      <span className="rounded-md bg-black/65 px-2 py-1 text-[11px] font-medium text-white backdrop-blur">{task.aspectRatio}</span>
                      {task.duration ? <span className="rounded-md bg-black/65 px-2 py-1 text-[11px] font-medium text-white backdrop-blur">{task.duration}s</span> : null}
                    </div>
                    {running && <div className="absolute inset-x-0 bottom-0 h-1 bg-white/10"><div className="h-full bg-blue-500 transition-all" style={{ width: `${Math.max(4, task.progress)}%` }} /></div>}
                  </div>
                  <div className="p-4">
                    <p className="line-clamp-2 min-h-10 text-sm leading-5 text-gray-800 dark:text-gray-200">{task.prompt}</p>
                    <div className="mt-3 flex items-center gap-2 text-[11px] text-gray-400">
                      <span className="max-w-[45%] truncate rounded bg-gray-100 px-2 py-1 dark:bg-white/[0.06]">{task.model}</span>
                      <span>{task.resolution}</span>
                      <span>·</span>
                      <span>{getElapsed(task.createdAt, task.updatedAt)}</span>
                    </div>
                    {task.error && <p className="mt-3 line-clamp-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-500/10 dark:text-red-300" title={task.error}>{task.error}</p>}
                    <div className="mt-3 flex items-center justify-between border-t border-gray-100 pt-3 dark:border-white/[0.06]">
                      <span className={`text-xs font-medium ${task.status === 'completed' ? 'text-emerald-600 dark:text-emerald-400' : task.status === 'failed' ? 'text-red-500' : 'text-blue-600 dark:text-blue-400'}`}>{getStatusLabel(task.status)}</span>
                      <div className="flex items-center gap-1">
                        {task.status === 'completed' && <button type="button" onClick={() => void download(task)} title="下载视频" aria-label="下载视频" className="rounded-lg p-2 text-gray-400 transition hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-white/[0.06] dark:hover:text-white"><DownloadIcon className="h-4 w-4" /></button>}
                        {(task.status === 'completed' || task.status === 'failed') && <button type="button" onClick={() => retry(task)} title="复用参数" aria-label="复用参数" className="rounded-lg p-2 text-gray-400 transition hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-white/[0.06] dark:hover:text-white"><RefreshIcon className="h-4 w-4" /></button>}
                        {!running && <button type="button" onClick={() => void remove(task)} title="删除任务" aria-label="删除任务" className="rounded-lg p-2 text-gray-400 transition hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-500/10"><TrashIcon className="h-4 w-4" /></button>}
                      </div>
                    </div>
                  </div>
                </article>
              )
            })}
          </div>
        ) : (
          <div className="flex min-h-[45vh] flex-col items-center justify-center text-center text-gray-400">
            <svg className="mb-4 h-14 w-14 text-gray-200 dark:text-gray-700" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="m15 10 4.5-2.5a1 1 0 0 1 1.5.87v7.26a1 1 0 0 1-1.5.87L15 14M5 6h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z" strokeWidth="1.5" /></svg>
            <p className="text-sm">{search || filter !== 'all' ? '没有找到匹配的视频任务' : '输入提示词开始生成视频'}</p>
          </div>
        )}
      </main>

      {assetPreview && (
        <div role="dialog" aria-modal="true" aria-label={assetPreview.title} onClick={() => setAssetPreview(null)} className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
          <div onClick={(e) => e.stopPropagation()} className={`w-full rounded-lg bg-white p-3 shadow-2xl dark:bg-gray-950 ${assetPreview.kind === 'audio' ? 'max-w-xl' : 'max-w-5xl'}`}>
            <div className="mb-3 flex items-center justify-between gap-3 px-1">
              <span className="truncate text-sm font-medium text-gray-700 dark:text-gray-200">{assetPreview.title}</span>
              <button type="button" onClick={() => setAssetPreview(null)} title="关闭" aria-label="关闭预览" className="flex h-8 w-8 flex-none items-center justify-center rounded text-xl leading-none text-gray-400 transition hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-white/[0.08] dark:hover:text-white">×</button>
            </div>
            {assetPreview.kind === 'image' && <img src={assetPreview.url} alt={assetPreview.title} className="max-h-[80vh] w-full object-contain" />}
            {assetPreview.kind === 'video' && <video src={assetPreview.url} controls autoPlay playsInline className="max-h-[80vh] w-full bg-black object-contain" />}
            {assetPreview.kind === 'audio' && <audio src={assetPreview.url} controls autoPlay className="w-full" />}
          </div>
        </div>
      )}

      <div data-no-drag-select className={`safe-area-x fixed inset-x-0 bottom-0 z-30 pb-[calc(12px+env(safe-area-inset-bottom,0px))] transition-[left] duration-200 sm:pb-[calc(16px+env(safe-area-inset-bottom,0px))] ${workspaceState.sidebarCollapsed ? 'lg:left-14' : 'lg:left-72'}`}>
        <div className="mx-auto max-w-5xl overflow-hidden rounded-xl border border-gray-200 bg-white/95 p-2 shadow-[0_-8px_32px_rgba(0,0,0,0.08)] backdrop-blur-xl dark:border-white/[0.1] dark:bg-gray-950/95 sm:p-3">
          {showConfig && (
            <div className="mb-2 grid gap-2 rounded-lg border border-gray-200 bg-gray-50 p-2 dark:border-white/[0.08] dark:bg-white/[0.04] sm:grid-cols-[1fr_1fr_auto]">
              <label className="min-w-0"><span className="mb-1 block text-[11px] text-gray-400">接口地址</span><input value={VIDEO_API_BASE_URL} readOnly aria-readonly="true" className="h-9 w-full cursor-not-allowed rounded-lg border border-gray-200 bg-white px-3 text-xs text-gray-500 outline-none dark:border-white/[0.08] dark:bg-gray-900 dark:text-gray-400" /></label>
              <label className="min-w-0"><span className="mb-1 block text-[11px] text-gray-400">API Key</span><input type="password" value={config.apiKey} onChange={(e) => setConfig({ ...config, apiKey: e.target.value })} placeholder="sk-..." className="h-9 w-full rounded-lg border border-gray-200 bg-white px-3 text-xs outline-none focus:border-blue-400 dark:border-white/[0.08] dark:bg-gray-900 dark:text-white" /></label>
              <button type="button" onClick={() => void loadModels()} disabled={loadingModels} className="self-end rounded-lg bg-gray-900 px-4 py-2 text-xs font-medium text-white transition hover:bg-gray-700 disabled:opacity-50 dark:bg-white dark:text-gray-900">{loadingModels ? '同步中' : '同步模型'}</button>
            </div>
          )}
          {message && <div className={`mb-2 flex items-start justify-between gap-2 rounded-lg px-3 py-2 text-xs ${message.type === 'error' ? 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-300' : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300'}`}><span className="line-clamp-2">{message.text}</span><button type="button" onClick={() => setMessage(null)} className="flex-none px-1 text-base leading-none" aria-label="关闭提示">×</button></div>}
          {showAssets && (
            <div className="mb-2 max-h-[42vh] overflow-y-auto rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-white/[0.08] dark:bg-white/[0.04]">
              {capabilities.maxImages || capabilities.referenceVideo || capabilities.maxAudios ? (
                <div className="grid gap-4 sm:grid-cols-3">
                  {Boolean(capabilities.maxImages) && <section className="min-w-0">
                    <div className="mb-2 flex items-center justify-between"><span className="text-xs font-medium text-gray-600 dark:text-gray-300">参考图片</span><span className="text-[11px] text-gray-400">{imageUrls.length}/{capabilities.maxImages}</span></div>
                    <div className="flex min-h-11 flex-wrap items-center gap-2">
                      {imageUrls.map((url, idx) => (
                        <div key={`${url}-${idx}`} className="group relative h-11 w-11 flex-none overflow-hidden rounded-lg border border-gray-200 bg-white dark:border-white/[0.1] dark:bg-gray-900">
                          <button type="button" onClick={() => setAssetPreview({ kind: 'image', url, title: `参考图片 ${idx + 1}` })} title="查看图片" className="absolute inset-0"><img src={url} alt={`参考图片 ${idx + 1}`} className="h-full w-full object-cover" /></button>
                          <button type="button" onClick={() => setImageUrlText(imageUrls.filter((_, imageIdx) => imageIdx !== idx).join('\n'))} title="移除图片" aria-label={`移除参考图片 ${idx + 1}`} className="absolute right-0.5 top-0.5 z-10 flex h-5 w-5 items-center justify-center rounded bg-black/65 text-white transition hover:bg-red-600"><TrashIcon className="h-3 w-3" /></button>
                        </div>
                      ))}
                      <label title="上传参考图片" className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-lg border border-dashed border-gray-300 text-gray-400 transition hover:border-blue-400 hover:text-blue-600 dark:border-white/[0.15]"><input type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple className="sr-only" disabled={uploadingAsset !== null} onChange={(e) => { const files = Array.from(e.target.files ?? []); e.currentTarget.value = ''; void uploadAssets(files, 'image') }} />{uploadingAsset === 'image' ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-blue-500" /> : <PlusIcon className="h-4 w-4" />}</label>
                    </div>
                  </section>}
                  {capabilities.referenceVideo && <section className="min-w-0">
                    <div className="mb-2 flex items-center justify-between"><span className="text-xs font-medium text-gray-600 dark:text-gray-300">参考视频</span><span className="text-[11px] text-gray-400">{capabilities.minReferenceVideoDuration ?? 0}–{capabilities.maxReferenceVideoDuration ?? 30}s</span></div>
                    <div className="flex min-h-11 items-center gap-2">
                      {referenceVideo && <div className="relative h-11 min-w-0 flex-1 overflow-hidden rounded-lg bg-gray-900"><button type="button" onClick={() => setAssetPreview({ kind: 'video', url: referenceVideo, title: '参考视频' })} className="flex h-full w-full items-center gap-2 px-2 text-left text-xs text-white"><video src={referenceVideo} muted playsInline preload="metadata" className="h-9 w-14 flex-none bg-black object-cover" /><span className="truncate">查看视频</span></button><button type="button" onClick={() => setReferenceVideo('')} title="移除视频" aria-label="移除参考视频" className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded bg-black/65 text-white hover:bg-red-600"><TrashIcon className="h-3 w-3" /></button></div>}
                      {!referenceVideo && <label title="上传参考视频" className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-lg border border-dashed border-gray-300 text-gray-400 transition hover:border-blue-400 hover:text-blue-600 dark:border-white/[0.15]"><input type="file" accept="video/mp4,video/webm,video/quicktime" className="sr-only" disabled={uploadingAsset !== null} onChange={(e) => { const files = Array.from(e.target.files ?? []); e.currentTarget.value = ''; void uploadAssets(files, 'video') }} />{uploadingAsset === 'video' ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-blue-500" /> : <PlusIcon className="h-4 w-4" />}</label>}
                    </div>
                  </section>}
                  {Boolean(capabilities.maxAudios) && <section className="min-w-0">
                    <div className="mb-2 flex items-center justify-between"><span className="text-xs font-medium text-gray-600 dark:text-gray-300">参考音频</span><span className="text-[11px] text-gray-400">{audioUrls.length}/{capabilities.maxAudios}</span></div>
                    <div className="flex min-h-11 flex-wrap items-center gap-2">
                      {audioUrls.map((url, idx) => <div key={`${url}-${idx}`} className="flex h-9 max-w-full items-center rounded-lg border border-gray-200 bg-white dark:border-white/[0.08] dark:bg-gray-900"><button type="button" onClick={() => setAssetPreview({ kind: 'audio', url, title: `参考音频 ${idx + 1}` })} className="max-w-28 truncate px-2 text-xs text-gray-600 dark:text-gray-300">音频 {idx + 1}</button><button type="button" onClick={() => setAudioUrlText(audioUrls.filter((_, audioIdx) => audioIdx !== idx).join('\n'))} title="移除音频" aria-label={`移除参考音频 ${idx + 1}`} className="flex h-8 w-7 items-center justify-center text-gray-400 hover:text-red-500"><TrashIcon className="h-3.5 w-3.5" /></button></div>)}
                      <label title="上传参考音频" className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg border border-dashed border-gray-300 text-gray-400 transition hover:border-blue-400 hover:text-blue-600 dark:border-white/[0.15]"><input type="file" accept="audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/x-m4a,audio/ogg,audio/aac" multiple className="sr-only" disabled={uploadingAsset !== null} onChange={(e) => { const files = Array.from(e.target.files ?? []); e.currentTarget.value = ''; void uploadAssets(files, 'audio') }} />{uploadingAsset === 'audio' ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-blue-500" /> : <PlusIcon className="h-4 w-4" />}</label>
                    </div>
                  </section>}
                </div>
              ) : <p className="text-center text-xs text-gray-400">当前模型不支持参考素材</p>}
            </div>
          )}
          <textarea
            ref={promptRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onFocus={() => setPromptFocused(true)}
            onBlur={(e) => { e.currentTarget.scrollTop = 0; setPromptFocused(false) }}
            onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') void submit() }}
            placeholder="描述镜头、主体动作、场景和风格…"
            aria-label="视频提示词"
            rows={1}
            className={`block w-full resize-none bg-transparent px-2 py-2 text-sm leading-6 text-gray-900 outline-none transition-[height] duration-200 placeholder:text-gray-400 dark:text-white ${promptFocused ? 'h-28 overflow-y-auto' : 'h-10 overflow-hidden'}`}
          />
          <div className="flex items-center gap-1.5 border-t border-gray-100 pt-2 dark:border-white/[0.06]">
            <button type="button" onClick={() => { setShowAssets((current) => !current); setShowConfig(false) }} title="管理参考素材" aria-label="管理参考素材" className={`flex h-9 flex-none items-center gap-1.5 rounded-lg border px-2 text-xs transition ${showAssets ? 'border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-500/40 dark:bg-blue-500/10 dark:text-blue-300' : 'border-gray-200 bg-gray-50 text-gray-600 hover:border-gray-300 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-300'}`}><PlusIcon className="h-4 w-4" /><span className="hidden sm:inline">素材</span><span className="text-[11px] text-gray-400">{referenceCount}/{referenceLimit}</span></button>
            <div className="min-w-0 flex-1 overflow-x-auto">
              <div className="flex w-max items-center gap-1.5">
                <label className="flex h-9 items-center gap-1 rounded-lg border border-gray-200 bg-gray-50 px-2 dark:border-white/[0.08] dark:bg-white/[0.04]"><span className="text-[11px] text-gray-400">模型</span><select aria-label="视频模型" value={config.model} onChange={(e) => setConfig({ ...config, model: e.target.value })} className="max-w-40 bg-transparent text-xs text-gray-700 outline-none dark:text-gray-200"><option value="">选择模型</option>{models.map((model) => <option key={model} value={model}>{model}</option>)}</select></label>
                <label className="flex h-9 items-center gap-1 rounded-lg border border-gray-200 bg-gray-50 px-2 dark:border-white/[0.08] dark:bg-white/[0.04]"><span className="text-[11px] text-gray-400">比例</span><select aria-label="视频比例" value={config.aspectRatio} onChange={(e) => setConfig({ ...config, aspectRatio: e.target.value })} className="bg-transparent text-xs text-gray-700 outline-none dark:text-gray-200">{capabilities.ratios.map((value) => <option key={value}>{value}</option>)}</select></label>
                <label className="flex h-9 items-center gap-1 rounded-lg border border-gray-200 bg-gray-50 px-2 dark:border-white/[0.08] dark:bg-white/[0.04]"><span className="text-[11px] text-gray-400">时长</span><select aria-label="视频时长" value={config.duration} onChange={(e) => setConfig({ ...config, duration: Number(e.target.value) })} className="bg-transparent text-xs text-gray-700 outline-none dark:text-gray-200">{capabilities.durations.map((value) => <option key={value} value={value}>{value ? `${value}s` : '自动'}</option>)}</select></label>
                <label className="flex h-9 items-center gap-1 rounded-lg border border-gray-200 bg-gray-50 px-2 dark:border-white/[0.08] dark:bg-white/[0.04]"><span className="text-[11px] text-gray-400">分辨率</span>{capabilities.resolutions.length > 1 ? <select aria-label="视频分辨率" value={config.resolution} onChange={(e) => setConfig({ ...config, resolution: e.target.value })} className="bg-transparent text-xs text-gray-700 outline-none dark:text-gray-200">{capabilities.resolutions.map((value) => <option key={value}>{value}</option>)}</select> : <span className="text-xs text-gray-700 dark:text-gray-200">{capabilities.resolutions[0] ?? '自动'}</span>}</label>
                <label className="flex h-9 items-center gap-1 rounded-lg border border-gray-200 bg-gray-50 px-2 dark:border-white/[0.08] dark:bg-white/[0.04]"><span className="text-[11px] text-gray-400">数量</span><select aria-label="生成数量" value={config.count} onChange={(e) => setConfig({ ...config, count: Number(e.target.value) })} className="bg-transparent text-xs text-gray-700 outline-none dark:text-gray-200">{[1, 2, 3, 4].map((value) => <option key={value}>{value}</option>)}</select></label>
              </div>
            </div>
            <button type="button" onClick={() => { setShowConfig((current) => !current); setShowAssets(false) }} title="视频接口配置" aria-label="视频接口配置" className={`flex h-9 w-9 flex-none items-center justify-center rounded-lg border transition ${showConfig ? 'border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-500/40 dark:bg-blue-500/10 dark:text-blue-300' : 'border-gray-200 text-gray-500 hover:bg-gray-50 dark:border-white/[0.08] dark:hover:bg-white/[0.04]'}`}><SettingsIcon className="h-4 w-4" /></button>
            <button type="button" onClick={() => void submit()} disabled={submitting} title="生成视频" aria-label="生成视频" className="flex h-10 w-10 flex-none items-center justify-center rounded-lg bg-blue-600 text-white shadow-sm transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50">{submitting ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" /> : <ArrowDownIcon className="h-4 w-4 rotate-180" />}</button>
          </div>
        </div>
      </div>
    </>
  )
}
