export interface VideoModel {
  id: string
  ownedBy?: string
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
}

export interface VideoApiTask {
  id?: string
  task_id?: string
  status?: string
  progress?: number
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

export async function fetchVideoModels(baseUrl: string, apiKey: string) {
  const data = await fetchJson<{ data?: Array<{ id?: string; owned_by?: string }> }>(
    getUrl(baseUrl, '/v1/models'),
    { headers: getHeaders(apiKey), cache: 'no-store' },
  )
  return (data.data ?? [])
    .filter((model): model is { id: string; owned_by?: string } => Boolean(model.id))
    .map((model) => ({ id: model.id, ownedBy: model.owned_by }))
}

export async function createVideoTask(baseUrl: string, apiKey: string, input: CreateVideoInput) {
  const commonBody = {
    model: input.model,
    prompt: input.prompt,
    ...(input.aspectRatio ? { aspect_ratio: input.aspectRatio } : {}),
    ...(input.duration ? { duration: input.duration } : {}),
    ...(input.resolution ? { resolution: input.resolution } : {}),
    ...(input.generateAudio !== undefined ? { generate_audio: input.generateAudio } : {}),
    ...(input.imageUrls?.length === 1 ? { image_url: input.imageUrls[0] } : {}),
    ...(input.imageUrls && input.imageUrls.length > 1 ? { image_urls: input.imageUrls } : {}),
    ...(input.referenceVideo ? { reference_video: input.referenceVideo } : {}),
  }
  const body = input.model === 'manxue-900'
    ? {
        model: input.model,
        prompt: input.prompt,
        ...(input.duration ? { duration: input.duration } : {}),
        ...(input.imageUrls?.length ? { images: input.imageUrls } : {}),
        metadata: {
          ...(input.aspectRatio ? { ratio: input.aspectRatio } : {}),
          ...(input.resolution ? { resolution: input.resolution } : {}),
        },
      }
    : input.model === 'manxue-933'
    ? {
        model: input.model,
        prompt: input.prompt,
        ...(input.aspectRatio ? { aspect_ratio: input.aspectRatio } : {}),
        ...(input.duration ? { seconds: input.duration } : {}),
        ...(input.resolution ? { resolution: input.resolution } : {}),
        ...(input.imageUrls?.[0] ? { image_url: input.imageUrls[0] } : {}),
        ...(input.imageUrls && input.imageUrls.length > 1 ? { reference_image_urls: input.imageUrls.slice(1) } : {}),
        ...(input.referenceVideo ? { reference_videos: [input.referenceVideo] } : {}),
      }
    : input.model === 'grok-imagine-1.0-video' || input.model === 'grok-imagine-video-1.5-preview'
    ? { model: input.model, prompt: input.prompt }
    : commonBody
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

export async function downloadVideoContent(baseUrl: string, apiKey: string, taskId: string) {
  const response = await fetch(getUrl(baseUrl, `/v1/videos/${encodeURIComponent(taskId)}/content`), {
    headers: getHeaders(apiKey),
    cache: 'no-store',
  })
  if (!response.ok) throw new Error(await getApiError(response))
  const contentType = response.headers.get('content-type')?.split(';')[0].trim() || ''
  if (!contentType.toLowerCase().startsWith('video/')) {
    throw new Error(`视频响应类型无效：${contentType || '未知'}`)
  }
  const blob = await response.blob()
  if (!blob.size) throw new Error('下载的视频内容为空')
  return { blob, contentType }
}

export function getVideoTaskError(task: VideoApiTask) {
  if (typeof task.error === 'string') return task.error
  return task.error?.message || '视频生成失败'
}
