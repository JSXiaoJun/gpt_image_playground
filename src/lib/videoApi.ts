export interface VideoModelCapabilities {
  ratios: string[]
  durations: number[]
  resolutions: string[]
  maxImages: number
  referenceVideo: boolean
  maxAudios?: number
  maxReferences?: number
  minReferenceVideoDuration?: number
  maxReferenceVideoDuration?: number
  minAudioDuration?: number
  maxAudioDuration?: number
  maxTotalAudioDuration?: number
  experimental?: boolean
}

export interface CreateVideoInput {
  model: string
  prompt: string
  aspectRatio?: string
  duration?: number
  resolution?: string
  generateAudio?: boolean
  imageUrls?: string[]
  referenceVideo?: string
  audioUrls?: string[]
}

export interface VideoApiTask {
  id?: string
  task_id?: string
  video_url?: string
  url?: string
  result_url?: string
  download_url?: string
  status?: string
  progress?: number | string
  error?: string | { message?: string } | null
  created_at?: number
  updated_at?: number
}

function getUrl(baseUrl: string, path: string) {
  return `${baseUrl.replace(/\/+$/, '')}${path}`
}

function getHeaders(apiKey: string, json = false) {
  return {
    Authorization: `Bearer ${apiKey}`,
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  }
}

async function getApiError(response: Response) {
  const text = await response.text().catch(() => '')
  if (!text) return `请求失败（HTTP ${response.status}）`

  try {
    const data = JSON.parse(text) as {
      error?: string | { message?: string; code?: string }
      message?: string
      code?: string
    }
    if (typeof data.error === 'string') return data.error
    return data.error?.message || data.message || data.error?.code || data.code || text
  } catch {
    return text
  }
}

async function fetchJson<T>(url: string, init: RequestInit) {
  const response = await fetch(url, init)
  if (!response.ok) throw new Error(await getApiError(response))
  return response.json() as Promise<T>
}

export async function fetchVideoModelCapabilities(baseUrl: string) {
  const data = await fetchJson<{ data?: Array<{ id?: unknown; capabilities?: unknown }> }>(
    getUrl(baseUrl, '/v1/model-capabilities'),
    { cache: 'no-store' },
  )
  return (data.data ?? []).flatMap((item) => {
    if (typeof item.id !== 'string' || !item.capabilities || typeof item.capabilities !== 'object' || Array.isArray(item.capabilities)) return []
    const value = item.capabilities as Partial<VideoModelCapabilities>
    if (
      !Array.isArray(value.ratios) || !value.ratios.every((item) => typeof item === 'string') ||
      !Array.isArray(value.durations) || !value.durations.every((item) => typeof item === 'number') ||
      !Array.isArray(value.resolutions) || !value.resolutions.every((item) => typeof item === 'string') ||
      typeof value.maxImages !== 'number' || typeof value.referenceVideo !== 'boolean'
    ) return []
    return [{ id: item.id, capabilities: value as VideoModelCapabilities }]
  })
}

export async function fetchVideoCatalog(baseUrl: string) {
  const capabilities = await fetchVideoModelCapabilities(baseUrl)
  return { models: capabilities.map((item) => item.id), capabilities }
}

export async function createVideoTask(baseUrl: string, apiKey: string, input: CreateVideoInput) {
  const body = {
    model: input.model,
    prompt: input.prompt,
    ...(input.aspectRatio ? { aspect_ratio: input.aspectRatio } : {}),
    ...(input.duration ? { duration: input.duration } : {}),
    ...(input.resolution ? { resolution: input.resolution } : {}),
    ...(input.generateAudio !== undefined ? { generate_audio: input.generateAudio } : {}),
    ...(input.imageUrls?.length ? { image_urls: input.imageUrls } : {}),
    ...(input.referenceVideo ? { reference_video: input.referenceVideo } : {}),
    ...(input.audioUrls?.length ? { audio_urls: input.audioUrls } : {}),
  }
  const task = await fetchJson<VideoApiTask>(getUrl(baseUrl, '/v1/videos'), {
    method: 'POST',
    headers: getHeaders(apiKey, true),
    body: JSON.stringify(body),
  })
  const taskId = task.task_id || task.id
  if (!taskId) throw new Error('创建响应中没有 task_id')
  return { taskId, task }
}

export function fetchVideoTask(baseUrl: string, apiKey: string, taskId: string) {
  return fetchJson<VideoApiTask>(getUrl(baseUrl, `/v1/videos/${encodeURIComponent(taskId)}`), {
    headers: getHeaders(apiKey),
    cache: 'no-store',
  })
}

export async function downloadVideoContent(baseUrl: string, apiKey: string, taskId: string, publicUrl?: string) {
  const directUrl = normalizeVideoContentUrl(publicUrl)
  const fallbackUrl = getUrl(baseUrl, `/v1/videos/${encodeURIComponent(taskId)}/content`)
  const directResponse = directUrl
    ? await fetch(directUrl, { cache: 'no-store' }).catch(() => null)
    : null
  const response = directResponse?.ok
    ? directResponse
    : await fetch(fallbackUrl, { headers: getHeaders(apiKey), cache: 'no-store' })
  if (!response.ok) throw new Error(await getApiError(response))
  const contentType = response.headers.get('content-type')?.split(';')[0].trim() || ''
  if (!contentType.toLowerCase().startsWith('video/') && contentType.toLowerCase() !== 'application/octet-stream') {
    throw new Error(`视频响应类型无效：${contentType || '未知'}`)
  }
  const blob = await response.blob()
  if (!blob.size) throw new Error('下载的视频内容为空')
  return { blob, contentType, extension: getVideoExtension(contentType, response.headers.get('content-disposition')) }
}

export function normalizeVideoTaskStatus(value?: string) {
  const status = String(value ?? '').trim().toLowerCase()
  if (['completed', 'success', 'succeeded'].includes(status)) return 'completed' as const
  if (['failed', 'failure', 'cancelled', 'canceled'].includes(status)) return 'failed' as const
  if (['processing', 'in_progress', 'running'].includes(status)) return 'processing' as const
  return 'queued' as const
}

export function normalizeVideoProgress(value: number | string | undefined, fallback = 0) {
  const progress = typeof value === 'string' ? Number.parseFloat(value.replace(/%$/, '')) : value
  return typeof progress === 'number' && Number.isFinite(progress)
    ? Math.max(0, Math.min(100, Math.round(progress)))
    : fallback
}

export function getVideoContentUrl(task: VideoApiTask) {
  for (const value of [task.video_url, task.url, task.result_url, task.download_url]) {
    const normalized = normalizeVideoContentUrl(value)
    if (normalized) return normalized
  }
}

function normalizeVideoContentUrl(value?: string) {
  if (!value) return ''
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return ''
    if (
      !['media.yyapi.cloud', 'www.yyapi.cloud', 'zl.yyapi.cloud'].includes(url.hostname) ||
      !/^\/public\/videos\/task_[A-Za-z0-9_-]+\/content$/.test(url.pathname)
    ) return ''
    if (
      (url.hostname === 'www.yyapi.cloud' || url.hostname === 'zl.yyapi.cloud') &&
      url.pathname.startsWith('/public/videos/')
    ) {
      url.protocol = 'https:'
      url.host = 'media.yyapi.cloud'
      url.search = ''
      url.hash = ''
    }
    return url.toString()
  } catch {
    return ''
  }
}

function getVideoExtension(contentType: string, contentDisposition: string | null) {
  const extensionByType: Record<string, string> = {
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
    'video/mpeg': 'mpeg',
    'video/ogg': 'ogv',
    'video/x-msvideo': 'avi',
    'video/x-matroska': 'mkv',
    'video/3gpp': '3gp',
    'video/3gpp2': '3g2',
  }
  const mapped = extensionByType[contentType.toLowerCase()]
  if (mapped) return mapped
  const fileName = contentDisposition?.match(/filename\*?=(?:UTF-8''|["']?)([^"';]+)/i)?.[1]
  const extension = fileName?.split('.').pop()?.toLowerCase()
  return extension && ['mp4', 'webm', 'mov', 'mpeg', 'mpg', 'ogv', 'avi', 'mkv', '3gp', '3g2'].includes(extension)
    ? extension
    : 'mp4'
}

export function getVideoTaskError(task: VideoApiTask) {
  if (typeof task.error === 'string') return task.error
  return task.error?.message || '视频生成失败'
}
