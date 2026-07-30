import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  createVideoTask,
  downloadVideoContent,
  fetchVideoModels,
  fetchVideoTask,
  getVideoTaskError,
} from '../lib/videoApi'
import { getAudioDuration, getVideoDuration } from '../lib/videoDuration'
import { uploadR2Asset } from '../lib/r2AssetUpload'
import { DownloadIcon, RefreshIcon, SettingsIcon, TrashIcon } from './icons'

type VideoTaskStatus = 'submitting' | 'queued' | 'processing' | 'completed' | 'failed'

interface VideoTaskRecord {
  id: string
  publicTaskId?: string
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

interface ModelCapabilities {
  ratios: string[]
  durations: number[]
  resolutions: string[]
  maxImages: number
  referenceVideo: boolean
  maxAudios?: number
  experimental?: boolean
}

const CONFIG_KEY = 'gpt-image-playground-video-config-v1'
const TASKS_KEY = 'gpt-image-playground-video-tasks-v1'
const VIDEO_API_BASE_URL = 'https://zl.yyapi.cloud'
const MAX_REFERENCE_VIDEO_DURATION_SECONDS = 30
const DEFAULT_CONFIG: VideoConfig = {
  apiKey: '',
  model: '',
  aspectRatio: '16:9',
  duration: 8,
  resolution: '720p',
  generateAudio: true,
  count: 1,
}
const DEFAULT_CAPABILITIES: ModelCapabilities = {
  ratios: ['16:9', '9:16'],
  durations: [4, 6, 8, 10],
  resolutions: ['720p', '1080p'],
  maxImages: 5,
  referenceVideo: false,
  experimental: true,
}
const MODEL_CAPABILITIES: Record<string, ModelCapabilities> = {
  'gemini-omni-flash': { ratios: ['16:9', '9:16'], durations: [4, 6, 8, 10], resolutions: ['720p', '1080p'], maxImages: 5, referenceVideo: true },
  sora2: { ratios: ['16:9', '9:16'], durations: [4, 8, 12], resolutions: ['720p'], maxImages: 1, referenceVideo: false, experimental: true },
  'veo31-fast': { ratios: ['16:9', '9:16'], durations: [4, 6, 8], resolutions: ['720p', '1080p'], maxImages: 2, referenceVideo: false, experimental: true },
  'manxue-933': { ratios: ['16:9', '9:16', '4:3', '3:4', '1:1', '21:9'], durations: [15], resolutions: ['720p'], maxImages: 9, referenceVideo: true, maxAudios: 3, experimental: true },
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
  return value.filter((task): task is VideoTaskRecord => Boolean(
    task &&
    typeof task === 'object' &&
    typeof task.id === 'string' &&
    typeof task.prompt === 'string' &&
    typeof task.model === 'string' &&
    typeof task.status === 'string' &&
    typeof task.createdAt === 'number',
  ))
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
  const [config, setConfig] = useState<VideoConfig>(readConfig)
  const [tasks, setTasks] = useState<VideoTaskRecord[]>(readTasks)
  const [models, setModels] = useState<string[]>([])
  const [prompt, setPrompt] = useState('')
  const [imageUrlText, setImageUrlText] = useState('')
  const [referenceVideo, setReferenceVideo] = useState('')
  const [audioUrlText, setAudioUrlText] = useState('')
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'all' | 'running' | 'completed' | 'failed'>('all')
  const [showConfig, setShowConfig] = useState(false)
  const [loadingModels, setLoadingModels] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [uploadingAsset, setUploadingAsset] = useState<'image' | 'video' | 'audio' | null>(null)
  const [message, setMessage] = useState<{ text: string; type: 'error' | 'success' } | null>(null)
  const [videoPreview, setVideoPreview] = useState<{ taskId: string; url: string } | null>(null)
  const pollingRef = useRef(new Set<string>())
  const videoPreviewRef = useRef<{ taskId: string; url: string } | null>(null)
  const tasksRef = useRef<VideoTaskRecord[]>(tasks)

  const capabilities = MODEL_CAPABILITIES[config.model] ?? DEFAULT_CAPABILITIES
  const imageUrls = imageUrlText.split(/\r?\n|,/).map((url) => url.trim()).filter(Boolean)
  const audioUrls = audioUrlText.split(/\r?\n|,/).map((url) => url.trim()).filter(Boolean)

  const uploadAsset = async (file: File, kind: 'image' | 'video' | 'audio') => {
    if (kind === 'image' && imageUrls.length >= capabilities.maxImages) {
      setMessage({ text: `当前模型最多支持 ${capabilities.maxImages} 张参考图`, type: 'error' })
      return
    }
    if (kind === 'video' && !capabilities.referenceVideo) {
      setMessage({ text: '当前模型不支持参考视频', type: 'error' })
      return
    }
    if (kind === 'audio' && (!capabilities.maxAudios || audioUrls.length >= capabilities.maxAudios)) {
      setMessage({ text: capabilities.maxAudios ? `当前模型最多支持 ${capabilities.maxAudios} 个参考音频` : '当前模型不支持参考音频', type: 'error' })
      return
    }

    setUploadingAsset(kind)
    try {
      if (kind === 'video') {
        const duration = await getVideoDuration(file)
        const maxDuration = config.model === 'manxue-933' ? 15 : MAX_REFERENCE_VIDEO_DURATION_SECONDS
        if (duration > maxDuration || (config.model === 'manxue-933' && duration < 2)) {
          setMessage({ text: `参考视频时长为 ${duration.toFixed(1)} 秒，必须在 ${config.model === 'manxue-933' ? '2–15' : '0–30'} 秒内`, type: 'error' })
          return
        }
      }
      if (kind === 'audio') {
        const duration = await getAudioDuration(file)
        if (duration < 2 || duration > 15) {
          setMessage({ text: `参考音频时长为 ${duration.toFixed(1)} 秒，必须在 2–15 秒内`, type: 'error' })
          return
        }
      }
      const url = await uploadR2Asset(file)
      if (kind === 'image') setImageUrlText((current) => [...current.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean), url].join('\n'))
      else if (kind === 'video') setReferenceVideo(url)
      else setAudioUrlText((current) => [...current.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean), url].join('\n'))
      setMessage({ text: `${kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音频'}上传成功`, type: 'success' })
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
  }, [tasks])

  useEffect(() => {
    videoPreviewRef.current = videoPreview
  }, [videoPreview])

  useEffect(() => () => {
    if (videoPreviewRef.current) URL.revokeObjectURL(videoPreviewRef.current.url)
  }, [])

  const updateTask = useCallback((id: string, patch: Partial<VideoTaskRecord>) => {
    setTasks((current) => current.map((task) => task.id === id ? { ...task, ...patch, updatedAt: Date.now() } : task))
  }, [])

  const loadPreview = useCallback(async (task: VideoTaskRecord) => {
    if (!task.publicTaskId || videoPreviewRef.current?.taskId === task.id) return
    const result = await downloadVideoContent(VIDEO_API_BASE_URL, config.apiKey, task.publicTaskId)
    if (videoPreviewRef.current) URL.revokeObjectURL(videoPreviewRef.current.url)
    const preview = { taskId: task.id, url: URL.createObjectURL(result.blob) }
    videoPreviewRef.current = preview
    setVideoPreview(preview)
  }, [config.apiKey])

  const pollTask = useCallback(async (task: VideoTaskRecord) => {
    if (!task.publicTaskId || pollingRef.current.has(task.id)) return
    pollingRef.current.add(task.id)
    try {
      const result = await fetchVideoTask(VIDEO_API_BASE_URL, config.apiKey, task.publicTaskId)
      const status = String(result.status ?? '').toLowerCase()
      const progress = typeof result.progress === 'number' ? result.progress : task.progress
      if (status === 'completed') {
        const completed = { ...task, status: 'completed' as const, progress: 100, updatedAt: Date.now() }
        updateTask(task.id, completed)
      } else if (status === 'failed' || status === 'cancelled') {
        updateTask(task.id, { status: 'failed', progress, error: getVideoTaskError(result) })
      } else {
        updateTask(task.id, { status: status === 'processing' || status === 'in_progress' ? 'processing' : 'queued', progress })
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
    if (!config.apiKey.trim()) {
      setShowConfig(true)
      setMessage({ text: '请先填写视频接口 API Key', type: 'error' })
      return
    }
    setLoadingModels(true)
    try {
      const loaded = await fetchVideoModels(VIDEO_API_BASE_URL, config.apiKey.trim())
      const ids = loaded.map((model) => model.id)
      setModels(ids)
      if (!ids.length) throw new Error('接口没有返回可用模型')
      if (!ids.includes(config.model)) setConfig((current) => ({ ...current, model: ids[0] }))
      setMessage({ text: `已同步 ${ids.length} 个模型`, type: 'success' })
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : '模型列表加载失败', type: 'error' })
    } finally {
      setLoadingModels(false)
    }
  }, [config.apiKey, config.model])

  useEffect(() => {
    if (config.apiKey && !models.length) void loadModels()
  }, [])

  useEffect(() => {
    const next = MODEL_CAPABILITIES[config.model] ?? DEFAULT_CAPABILITIES
    if (!next.referenceVideo) setReferenceVideo('')
    if (!next.maxAudios) setAudioUrlText('')
    setConfig((current) => ({
      ...current,
      aspectRatio: next.ratios.includes(current.aspectRatio) ? current.aspectRatio : next.ratios[0],
      duration: next.durations.includes(current.duration) ? current.duration : next.durations[0],
      resolution: next.resolutions.includes(current.resolution) ? current.resolution : next.resolutions[0],
    }))
  }, [config.model])

  const submit = async () => {
    if (!config.apiKey.trim()) {
      setShowConfig(true)
      setMessage({ text: '请先填写视频接口 API Key', type: 'error' })
      return
    }
    if (!config.model) {
      setMessage({ text: '请先刷新并选择视频模型', type: 'error' })
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
    if (config.model === 'manxue-933' && imageUrls.length + audioUrls.length + (referenceVideo ? 1 : 0) > 12) {
      setMessage({ text: 'manxue-933 的图片、视频和音频合计不能超过 12 个', type: 'error' })
      return
    }

    if (referenceVideo) {
      setSubmitting(true)
      try {
        const duration = await getVideoDuration(referenceVideo)
        const maxDuration = config.model === 'manxue-933' ? 15 : MAX_REFERENCE_VIDEO_DURATION_SECONDS
        if (duration > maxDuration || (config.model === 'manxue-933' && duration < 2)) {
          setMessage({ text: `参考视频时长为 ${duration.toFixed(1)} 秒，必须在 ${config.model === 'manxue-933' ? '2–15' : '0–30'} 秒内`, type: 'error' })
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
        const invalidDuration = durations.find((duration) => duration < 2 || duration > 15)
        if (invalidDuration !== undefined) {
          setMessage({ text: `参考音频时长为 ${invalidDuration.toFixed(1)} 秒，单个音频必须在 2–15 秒内`, type: 'error' })
          setSubmitting(false)
          return
        }
        const totalDuration = durations.reduce((sum, duration) => sum + duration, 0)
        if (totalDuration > 15) {
          setMessage({ text: `参考音频总时长为 ${totalDuration.toFixed(1)} 秒，不能超过 15 秒`, type: 'error' })
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
      const now = Date.now()
      const localId = crypto.randomUUID()
      const draft: VideoTaskRecord = {
        id: localId,
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
          status: result.task.status === 'processing' ? 'processing' : 'queued',
          progress: result.task.progress ?? 0,
        })
      } catch (err) {
        updateTask(localId, { status: 'failed', error: err instanceof Error ? err.message : '创建任务失败' })
      }
    }
    setSubmitting(false)
    setPrompt('')
  }

  const remove = async (task: VideoTaskRecord) => {
    setTasks((current) => current.filter((item) => item.id !== task.id))
    if (videoPreviewRef.current?.taskId === task.id) {
      URL.revokeObjectURL(videoPreviewRef.current.url)
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
  }

  const download = async (task: VideoTaskRecord) => {
    try {
      if (!task.publicTaskId) throw new Error('任务 ID 不存在')
      const result = await downloadVideoContent(VIDEO_API_BASE_URL, config.apiKey, task.publicTaskId)
      const url = URL.createObjectURL(result.blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `${task.model}-${task.publicTaskId}.${result.contentType.includes('webm') ? 'webm' : 'mp4'}`
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : '视频下载失败', type: 'error' })
    }
  }

  const filteredTasks = useMemo(() => tasks.filter((task) => {
    if (filter === 'running' && !['submitting', 'queued', 'processing'].includes(task.status)) return false
    if (filter === 'completed' && task.status !== 'completed') return false
    if (filter === 'failed' && task.status !== 'failed') return false
    const query = search.trim().toLowerCase()
    return !query || task.prompt.toLowerCase().includes(query) || task.model.toLowerCase().includes(query) || task.publicTaskId?.toLowerCase().includes(query)
  }), [filter, search, tasks])

  return (
    <>
      <main className="safe-area-x mx-auto max-w-7xl pb-[310px]">
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
                      <video src={videoPreview.url} controls playsInline preload="metadata" className="h-full w-full object-contain" />
                    ) : (
                      <div className="flex h-full flex-col items-center justify-center gap-3 text-gray-400">
                        {running ? <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-700 border-t-blue-500" /> : <svg className="h-10 w-10 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="m15 10 4.5-2.5a1 1 0 0 1 1.5.87v7.26a1 1 0 0 1-1.5.87L15 14M5 6h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z" strokeWidth="1.5" /></svg>}
                        <span className="text-xs">{getStatusLabel(task.status)}{running && task.progress ? ` ${task.progress}%` : ''}</span>
                        {task.status === 'completed' && <button type="button" onClick={() => void loadPreview(task).catch((err) => setMessage({ text: err instanceof Error ? err.message : '视频预览加载失败', type: 'error' }))} className="rounded-lg bg-white/10 px-3 py-1.5 text-xs text-white transition hover:bg-white/20">加载预览</button>}
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

      <div data-no-drag-select className="safe-area-x fixed inset-x-0 bottom-0 z-30 pb-[calc(16px+env(safe-area-inset-bottom,0px))]">
        <div className="mx-auto max-w-5xl overflow-visible rounded-2xl border border-gray-200 bg-white/95 p-3 shadow-[0_-8px_40px_rgba(0,0,0,0.08)] backdrop-blur-xl dark:border-white/[0.1] dark:bg-gray-950/95 sm:p-4">
          {showConfig && (
            <div className="mb-3 grid gap-3 border-b border-gray-100 pb-3 dark:border-white/[0.06] sm:grid-cols-[1fr_1fr_auto]">
              <label className="min-w-0"><span className="mb-1 block text-[11px] text-gray-400">接口地址</span><input value={VIDEO_API_BASE_URL} readOnly aria-readonly="true" className="h-10 w-full cursor-not-allowed rounded-lg border border-gray-200 bg-gray-100 px-3 text-sm text-gray-500 outline-none dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-400" /></label>
              <label className="min-w-0"><span className="mb-1 block text-[11px] text-gray-400">API Key</span><input type="password" value={config.apiKey} onChange={(e) => setConfig({ ...config, apiKey: e.target.value })} placeholder="sk-..." className="h-10 w-full rounded-lg border border-gray-200 bg-gray-50 px-3 text-sm outline-none focus:border-blue-400 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-white" /></label>
              <button type="button" onClick={() => void loadModels()} disabled={loadingModels} className="self-end rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-gray-700 disabled:opacity-50 dark:bg-white dark:text-gray-900">{loadingModels ? '同步中' : '同步模型'}</button>
            </div>
          )}
          {message && <div className={`mb-3 flex items-center justify-between rounded-lg px-3 py-2 text-xs ${message.type === 'error' ? 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-300' : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300'}`}><span>{message.text}</span><button type="button" onClick={() => setMessage(null)} className="px-1 text-base leading-none" aria-label="关闭提示">×</button></div>}
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') void submit() }} placeholder="描述镜头、主体动作、场景和风格…" rows={2} className="w-full resize-none bg-transparent px-1 text-sm leading-6 text-gray-900 outline-none placeholder:text-gray-400 dark:text-white" />
          <div className="mt-2 grid gap-2 border-t border-gray-100 pt-3 dark:border-white/[0.06] sm:grid-cols-2">
              <div>
                <label className="block"><span className="mb-1 block text-[11px] text-gray-400">参考图片 URL（每行一个，最多 {capabilities.maxImages} 张）</span><textarea value={imageUrlText} onChange={(e) => setImageUrlText(e.target.value)} disabled={!capabilities.maxImages} rows={2} placeholder="https://example.com/reference.png" className="w-full resize-none rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs outline-none focus:border-blue-400 disabled:opacity-40 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-white" /></label>
                <label className="mt-2 inline-flex cursor-pointer items-center rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600 transition hover:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-300"><input type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="sr-only" disabled={!capabilities.maxImages || uploadingAsset !== null} onChange={(e) => { const file = e.target.files?.[0]; e.currentTarget.value = ''; if (file) void uploadAsset(file, 'image') }} />{uploadingAsset === 'image' ? '上传中…' : '上传图片'}</label>
              </div>
              {capabilities.referenceVideo && <div>
                <label className="block"><span className="mb-1 block text-[11px] text-gray-400">参考视频 URL（{config.model === 'manxue-933' ? '2–15' : '最长 30'} 秒）</span><input value={referenceVideo} onChange={(e) => setReferenceVideo(e.target.value)} placeholder="https://example.com/source.mp4" className="h-[58px] w-full rounded-lg border border-gray-200 bg-gray-50 px-3 text-xs outline-none focus:border-blue-400 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-white" /></label>
                <label className="mt-2 inline-flex cursor-pointer items-center rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600 transition hover:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-300"><input type="file" accept="video/mp4,video/webm,video/quicktime" className="sr-only" disabled={uploadingAsset !== null} onChange={(e) => { const file = e.target.files?.[0]; e.currentTarget.value = ''; if (file) void uploadAsset(file, 'video') }} />{uploadingAsset === 'video' ? '上传中…' : '上传视频'}</label>
              </div>}
              {capabilities.maxAudios && <div>
                <label className="block"><span className="mb-1 block text-[11px] text-gray-400">参考音频 URL（每行一个，最多 {capabilities.maxAudios} 个，总时长 15 秒）</span><textarea value={audioUrlText} onChange={(e) => setAudioUrlText(e.target.value)} rows={2} placeholder="https://example.com/reference.mp3" className="w-full resize-none rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs outline-none focus:border-blue-400 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-white" /></label>
                <label className="mt-2 inline-flex cursor-pointer items-center rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600 transition hover:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-300"><input type="file" accept="audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/x-m4a,audio/ogg,audio/aac" className="sr-only" disabled={uploadingAsset !== null} onChange={(e) => { const file = e.target.files?.[0]; e.currentTarget.value = ''; if (file) void uploadAsset(file, 'audio') }} />{uploadingAsset === 'audio' ? '上传中…' : '上传音频'}</label>
              </div>}
          </div>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <label className="min-w-[170px] flex-1 sm:flex-none"><span className="mb-1 block text-[11px] text-gray-400">模型 {capabilities.experimental ? '· 测试中' : ''}</span><select value={config.model} onChange={(e) => setConfig({ ...config, model: e.target.value })} className="h-10 w-full rounded-lg border border-gray-200 bg-gray-50 px-3 text-xs outline-none dark:border-white/[0.08] dark:bg-gray-900 dark:text-white"><option value="">选择模型</option>{models.map((model) => <option key={model} value={model}>{model}</option>)}</select></label>
            <label><span className="mb-1 block text-[11px] text-gray-400">比例</span><select value={config.aspectRatio} onChange={(e) => setConfig({ ...config, aspectRatio: e.target.value })} className="h-10 rounded-lg border border-gray-200 bg-gray-50 px-3 text-xs dark:border-white/[0.08] dark:bg-gray-900 dark:text-white">{capabilities.ratios.map((value) => <option key={value}>{value}</option>)}</select></label>
            <label><span className="mb-1 block text-[11px] text-gray-400">时长</span><select value={config.duration} onChange={(e) => setConfig({ ...config, duration: Number(e.target.value) })} className="h-10 rounded-lg border border-gray-200 bg-gray-50 px-3 text-xs dark:border-white/[0.08] dark:bg-gray-900 dark:text-white">{capabilities.durations.map((value) => <option key={value} value={value}>{value ? `${value}s` : '自动'}</option>)}</select></label>
            <label><span className="mb-1 block text-[11px] text-gray-400">分辨率</span><select value={config.resolution} onChange={(e) => setConfig({ ...config, resolution: e.target.value })} className="h-10 rounded-lg border border-gray-200 bg-gray-50 px-3 text-xs dark:border-white/[0.08] dark:bg-gray-900 dark:text-white">{capabilities.resolutions.map((value) => <option key={value}>{value}</option>)}</select></label>
            <label><span className="mb-1 block text-[11px] text-gray-400">数量</span><select value={config.count} onChange={(e) => setConfig({ ...config, count: Number(e.target.value) })} className="h-10 rounded-lg border border-gray-200 bg-gray-50 px-3 text-xs dark:border-white/[0.08] dark:bg-gray-900 dark:text-white">{[1, 2, 3, 4].map((value) => <option key={value}>{value}</option>)}</select></label>
            <button type="button" onClick={() => setShowConfig(!showConfig)} title="视频接口配置" aria-label="视频接口配置" className={`flex h-10 w-10 items-center justify-center rounded-lg border transition ${showConfig ? 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-500/30 dark:bg-blue-500/10' : 'border-gray-200 text-gray-500 dark:border-white/[0.08]'}`}><SettingsIcon className="h-4 w-4" /></button>
            <button type="button" onClick={() => void submit()} disabled={submitting} className="ml-auto flex h-10 min-w-[92px] items-center justify-center rounded-lg bg-blue-600 px-5 text-sm font-medium text-white shadow-sm transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50">{submitting ? '提交中' : '生成视频'}</button>
          </div>
        </div>
      </div>
    </>
  )
}
