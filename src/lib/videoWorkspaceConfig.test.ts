import { describe, expect, it } from 'vitest'
import { DEFAULT_VIDEO_CONFIG, normalizeVideoConfig } from './videoWorkspaceConfig'

describe('normalizeVideoConfig', () => {
  it('migrates the legacy API key to YYAPI', () => {
    expect(normalizeVideoConfig({
      apiKey: 'sk-legacy',
      model: 'gemini-omni-flash',
      aspectRatio: '9:16',
      duration: 10,
      resolution: '720p',
      count: 2,
    })).toEqual({
      provider: 'yyapi',
      apiKeys: { yyapi: 'sk-legacy', pro666: '' },
      model: 'gemini-omni-flash',
      aspectRatio: '9:16',
      duration: 10,
      resolution: '720p',
      generateAudio: true,
      autoFace: false,
      count: 2,
    })
  })

  it('keeps separate provider credentials', () => {
    const config = normalizeVideoConfig({
      provider: 'pro666',
      apiKeys: { yyapi: 'sk-yyapi', pro666: 'sk-pro666' },
      model: 'veo-omni',
      autoFace: true,
    })

    expect(config.provider).toBe('pro666')
    expect(config.apiKeys).toEqual({ yyapi: 'sk-yyapi', pro666: 'sk-pro666' })
    expect(config.autoFace).toBe(true)
  })

  it('uses defaults for invalid persisted data', () => {
    expect(normalizeVideoConfig(null)).toBe(DEFAULT_VIDEO_CONFIG)
    expect(normalizeVideoConfig({ provider: 'unknown', count: 99 }).provider).toBe('yyapi')
    expect(normalizeVideoConfig({ provider: 'unknown', count: 99 }).count).toBe(1)
  })
})
