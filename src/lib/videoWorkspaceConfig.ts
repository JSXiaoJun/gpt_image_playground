import { normalizeVideoProviderId, type VideoProviderId } from './videoProviders'

export interface VideoConfig {
  provider: VideoProviderId
  apiKeys: Record<VideoProviderId, string>
  model: string
  aspectRatio: string
  duration: number
  resolution: string
  generateAudio: boolean
  autoFace: boolean
  count: number
}

export const DEFAULT_VIDEO_CONFIG: VideoConfig = {
  provider: 'yyapi',
  apiKeys: { yyapi: '', pro666: '' },
  model: '',
  aspectRatio: '16:9',
  duration: 8,
  resolution: '720p',
  generateAudio: true,
  autoFace: false,
  count: 1,
}

export function normalizeVideoConfig(value: unknown): VideoConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return DEFAULT_VIDEO_CONFIG
  const config = value as Partial<VideoConfig> & { apiKey?: unknown }
  const legacyApiKey = typeof config.apiKey === 'string' ? config.apiKey : ''
  return {
    provider: normalizeVideoProviderId(config.provider),
    apiKeys: {
      yyapi: typeof config.apiKeys?.yyapi === 'string' ? config.apiKeys.yyapi : legacyApiKey,
      pro666: typeof config.apiKeys?.pro666 === 'string' ? config.apiKeys.pro666 : '',
    },
    model: typeof config.model === 'string' ? config.model : '',
    aspectRatio: typeof config.aspectRatio === 'string' ? config.aspectRatio : DEFAULT_VIDEO_CONFIG.aspectRatio,
    duration: typeof config.duration === 'number' ? config.duration : DEFAULT_VIDEO_CONFIG.duration,
    resolution: typeof config.resolution === 'string' ? config.resolution : DEFAULT_VIDEO_CONFIG.resolution,
    generateAudio: true,
    autoFace: config.autoFace === true,
    count: [1, 2, 3, 4].includes(config.count ?? 0) ? config.count! : 1,
  }
}
