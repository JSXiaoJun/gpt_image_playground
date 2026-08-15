import { createPro666VideoTask, getPro666VideoContentUrl, isPro666ProtectedVideoUrl, normalizePro666DownloadUrl, PRO666_VIDEO_API_BASE_URL, PRO666_VIDEO_CAPABILITIES, PRO666_VIDEO_MODELS } from './pro666VideoApi'
import { createVideoTask, downloadVideoContent, fetchVideoCatalog, fetchVideoTask, getVideoContentUrl, type CreateVideoInput, type VideoApiTask, type VideoModelCapabilities } from './videoApi'

export type VideoProviderId = 'yyapi' | 'pro666'

export const VIDEO_PROVIDERS: Array<{ id: VideoProviderId; name: string; apiBaseUrl: string }> = [
  { id: 'yyapi', name: 'YYAPI', apiBaseUrl: 'https://video-admin.yyapi.cloud/new-api' },
  { id: 'pro666', name: 'Pro666', apiBaseUrl: PRO666_VIDEO_API_BASE_URL },
]

export function normalizeVideoProviderId(value?: string): VideoProviderId {
  return value === 'pro666' ? 'pro666' : 'yyapi'
}

export function getVideoProvider(id: VideoProviderId) {
  return VIDEO_PROVIDERS.find((provider) => provider.id === id)!
}

export function getBundledVideoCatalog(id: VideoProviderId): { models: string[]; capabilities: Record<string, VideoModelCapabilities> } | null {
  if (id !== 'pro666') return null
  return { models: PRO666_VIDEO_MODELS, capabilities: PRO666_VIDEO_CAPABILITIES }
}

export async function fetchVideoProviderCatalog(id: VideoProviderId) {
  if (id === 'pro666') return getBundledVideoCatalog(id)!
  const catalog = await fetchVideoCatalog('https://video-admin.yyapi.cloud')
  return {
    models: catalog.models,
    capabilities: Object.fromEntries(catalog.capabilities.map((item) => [item.id, item.capabilities])),
  }
}

export function createProviderVideoTask(id: VideoProviderId, apiKey: string, input: CreateVideoInput) {
  if (id === 'pro666') return createPro666VideoTask(apiKey, input)
  return createVideoTask(getVideoProvider(id).apiBaseUrl, apiKey, input)
}

export function fetchProviderVideoTask(id: VideoProviderId, apiKey: string, taskId: string) {
  return fetchVideoTask(getVideoProvider(id).apiBaseUrl, apiKey, taskId)
}

export function getProviderVideoContentUrl(id: VideoProviderId, task: VideoApiTask) {
  return id === 'pro666' ? getPro666VideoContentUrl(task) : getVideoContentUrl(task)
}

export function downloadProviderVideoContent(id: VideoProviderId, apiKey: string, taskId: string, publicUrl?: string) {
  return downloadVideoContent(
    getVideoProvider(id).apiBaseUrl,
    apiKey,
    taskId,
    publicUrl,
    id === 'pro666' ? normalizePro666DownloadUrl : undefined,
    id === 'pro666' ? isPro666ProtectedVideoUrl : undefined,
  )
}
