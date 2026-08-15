import { getVideoContentUrl, submitVideoTask, type CreateVideoInput, type VideoApiTask, type VideoModelCapabilities } from './videoApi'

export const PRO666_VIDEO_API_BASE_URL = 'https://api.pro666.top'

const COMMON_RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16']
const SEEDANCE_DURATIONS = Array.from({ length: 12 }, (_, idx) => idx + 4)

export const PRO666_VIDEO_CAPABILITIES: Record<string, VideoModelCapabilities> = {
  'firefly-seedance2-1080p': { ratios: COMMON_RATIOS, durations: SEEDANCE_DURATIONS, resolutions: ['1080p'], maxImages: 9, referenceVideo: true, maxVideos: 3, maxAudios: 3, maxReferences: 12, autoFace: true, firstLastFrame: true },
  'firefly-seedance2-480p': { ratios: COMMON_RATIOS, durations: SEEDANCE_DURATIONS, resolutions: ['480p'], maxImages: 9, referenceVideo: true, maxVideos: 3, maxAudios: 3, maxReferences: 12, autoFace: true, firstLastFrame: true },
  'firefly-seedance2-720p': { ratios: COMMON_RATIOS, durations: SEEDANCE_DURATIONS, resolutions: ['720p'], maxImages: 9, referenceVideo: true, maxVideos: 3, maxAudios: 3, maxReferences: 12, autoFace: true, firstLastFrame: true },
  'firefly-seedance2-fast-480p': { ratios: COMMON_RATIOS, durations: SEEDANCE_DURATIONS, resolutions: ['480p'], maxImages: 9, referenceVideo: true, maxVideos: 3, maxAudios: 3, maxReferences: 12, autoFace: true, firstLastFrame: true },
  'firefly-seedance2-fast-720p': { ratios: COMMON_RATIOS, durations: SEEDANCE_DURATIONS, resolutions: ['720p'], maxImages: 9, referenceVideo: true, maxVideos: 3, maxAudios: 3, maxReferences: 12, autoFace: true, firstLastFrame: true },
  'sd2-431-720p-fast': { ratios: COMMON_RATIOS, durations: SEEDANCE_DURATIONS, resolutions: ['720p'], maxImages: 4, referenceVideo: true, maxVideos: 3, maxAudios: 1, firstLastFrame: true },
  'sd2-431-720p-pro': { ratios: COMMON_RATIOS, durations: SEEDANCE_DURATIONS, resolutions: ['720p'], maxImages: 4, referenceVideo: true, maxVideos: 3, maxAudios: 1, firstLastFrame: true },
  'sd2-5-vref-720p': { ratios: COMMON_RATIOS, durations: Array.from({ length: 27 }, (_, idx) => idx + 4), resolutions: ['720p'], maxImages: 30, referenceVideo: true, maxVideos: 10, maxAudios: 10, minReferenceVideoDuration: 3, maxReferenceVideoDuration: 10, minAudioDuration: 2, maxAudioDuration: 30, maxTotalAudioDuration: 30, firstLastFrame: true },
  'veo-omni': { ratios: ['16:9', '9:16'], durations: [10], resolutions: ['720p'], maxImages: 9, referenceVideo: false },
  'video-900': { ratios: ['自动'], durations: [0], resolutions: ['自动'], maxImages: 0, referenceVideo: false, experimental: true },
  'video-v1': { ratios: ['16:9', '9:16', '1:1'], durations: [5, 10, 15], resolutions: ['自动'], maxImages: 9, referenceVideo: false },
  'video-v1-face': { ratios: ['16:9', '9:16', '1:1'], durations: [5, 10, 15], resolutions: ['自动'], maxImages: 9, referenceVideo: false },
}

export const PRO666_VIDEO_MODELS = Object.keys(PRO666_VIDEO_CAPABILITIES)

export function buildPro666VideoRequest(input: CreateVideoInput) {
  const videoUrls = input.videoUrls ?? (input.referenceVideo ? [input.referenceVideo] : [])
  const common = {
    model: input.model,
    prompt: input.prompt,
    ...(input.duration ? { duration: input.duration } : {}),
    ...(input.aspectRatio ? { aspect_ratio: input.aspectRatio } : {}),
    ...(input.resolution ? { resolution: input.resolution } : {}),
  }

  if (input.model === 'veo-omni') {
    return {
      model: input.model,
      prompt: input.prompt,
      ...(input.duration ? { seconds: String(input.duration) } : {}),
      ...(input.aspectRatio ? { aspect_ratio: input.aspectRatio } : {}),
      ...(input.resolution ? { resolution: input.resolution } : {}),
      ...(input.imageUrls?.length ? {
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: input.prompt },
            ...input.imageUrls.map((url) => ({ type: 'image_url', image_url: { url, detail: 'high' } })),
          ],
        }],
      } : {}),
    }
  }

  if (input.model === 'video-v1' || input.model === 'video-v1-face') {
    return {
      ...common,
      ...(input.imageUrls?.length ? { images: input.imageUrls } : {}),
    }
  }

  if (input.model === 'video-900') return common

  if (input.firstFrameUrl || input.lastFrameUrl) {
    return {
      ...common,
      ...(input.generateAudio !== undefined ? { generate_audio: input.generateAudio } : {}),
      ...(input.firstFrameUrl ? { first_frame_url: input.firstFrameUrl } : {}),
      ...(input.lastFrameUrl ? { last_frame_url: input.lastFrameUrl } : {}),
      ...(input.autoFace ? { auto_face: true } : {}),
    }
  }

  return {
    ...common,
    ...(input.generateAudio !== undefined ? { generate_audio: input.generateAudio } : {}),
    ...(input.imageUrls?.length ? { images: input.imageUrls } : {}),
    ...(videoUrls.length ? { videos: videoUrls } : {}),
    ...(input.audioUrls?.length ? { audios: input.audioUrls } : {}),
    ...(input.autoFace ? { auto_face: true } : {}),
  }
}

export function createPro666VideoTask(apiKey: string, input: CreateVideoInput) {
  return submitVideoTask(PRO666_VIDEO_API_BASE_URL, apiKey, buildPro666VideoRequest(input))
}

export function normalizePro666VideoContentUrl(value?: string) {
  if (!value) return ''
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:') return ''
    if (['pro666.top', 'api.pro666.top'].includes(url.hostname) && url.pathname.startsWith('/v1/videos/')) return ''
    return url.toString()
  } catch {
    return ''
  }
}

export function normalizePro666DownloadUrl(value?: string) {
  if (!value) return ''
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.toString() : ''
  } catch {
    return ''
  }
}

export function isPro666ProtectedVideoUrl(value: string) {
  const url = new URL(value)
  return ['pro666.top', 'api.pro666.top'].includes(url.hostname) && url.pathname.startsWith('/v1/videos/')
}

export function getPro666VideoContentUrl(task: VideoApiTask) {
  return getVideoContentUrl(task, normalizePro666VideoContentUrl)
}
