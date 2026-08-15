import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildPro666VideoRequest, createPro666VideoTask, getPro666VideoContentUrl, normalizePro666VideoContentUrl, PRO666_VIDEO_CAPABILITIES, PRO666_VIDEO_MODELS } from './pro666VideoApi'
import { downloadProviderVideoContent } from './videoProviders'

afterEach(() => vi.unstubAllGlobals())

describe('pro666VideoApi', () => {
  it('registers every model shown by the channel', () => {
    expect(PRO666_VIDEO_MODELS).toEqual([
      'firefly-seedance2-1080p',
      'firefly-seedance2-480p',
      'firefly-seedance2-720p',
      'firefly-seedance2-fast-480p',
      'firefly-seedance2-fast-720p',
      'sd2-431-720p-fast',
      'sd2-431-720p-pro',
      'sd2-5-vref-720p',
      'veo-omni',
      'video-900',
      'video-v1',
      'video-v1-face',
    ])
    expect(PRO666_VIDEO_CAPABILITIES['sd2-5-vref-720p'].durations).toEqual(Array.from({ length: 27 }, (_, idx) => idx + 4))
    expect(PRO666_VIDEO_CAPABILITIES['sd2-5-vref-720p'].maxImages).toBe(30)
    expect(PRO666_VIDEO_CAPABILITIES['sd2-5-vref-720p'].maxVideos).toBe(10)
    expect(PRO666_VIDEO_CAPABILITIES['sd2-5-vref-720p'].maxAudios).toBe(10)
    expect(PRO666_VIDEO_CAPABILITIES['sd2-5-vref-720p']).toMatchObject({
      minReferenceVideoDuration: 3,
      maxReferenceVideoDuration: 10,
      minAudioDuration: 2,
      maxAudioDuration: 30,
      maxTotalAudioDuration: 30,
      firstLastFrame: true,
    })
  })

  it('maps Firefly reference assets and face processing', () => {
    expect(buildPro666VideoRequest({
      model: 'firefly-seedance2-fast-720p',
      prompt: '让角色自然转身',
      duration: 8,
      aspectRatio: '9:16',
      resolution: '720p',
      generateAudio: true,
      imageUrls: ['https://example.com/a.png'],
      videoUrls: ['https://example.com/a.mp4'],
      audioUrls: ['https://example.com/a.mp3'],
      autoFace: true,
    })).toEqual({
      model: 'firefly-seedance2-fast-720p',
      prompt: '让角色自然转身',
      duration: 8,
      aspect_ratio: '9:16',
      resolution: '720p',
      generate_audio: true,
      images: ['https://example.com/a.png'],
      videos: ['https://example.com/a.mp4'],
      audios: ['https://example.com/a.mp3'],
      auto_face: true,
    })
  })

  it('keeps first and last frames separate from reference assets', () => {
    expect(buildPro666VideoRequest({
      model: 'sd2-431-720p-pro',
      prompt: '从首帧自然过渡到尾帧',
      duration: 8,
      aspectRatio: '16:9',
      resolution: '720p',
      generateAudio: true,
      imageUrls: ['https://example.com/reference.png'],
      videoUrls: ['https://example.com/reference.mp4'],
      audioUrls: ['https://example.com/reference.mp3'],
      firstFrameUrl: 'https://example.com/first.png',
      lastFrameUrl: 'https://example.com/last.png',
    })).toEqual({
      model: 'sd2-431-720p-pro',
      prompt: '从首帧自然过渡到尾帧',
      duration: 8,
      aspect_ratio: '16:9',
      resolution: '720p',
      generate_audio: true,
      first_frame_url: 'https://example.com/first.png',
      last_frame_url: 'https://example.com/last.png',
    })
  })

  it('maps Veo references to multimodal messages without audio fields', () => {
    expect(buildPro666VideoRequest({
      model: 'veo-omni',
      prompt: '参考人物生成视频',
      duration: 10,
      aspectRatio: '16:9',
      resolution: '720p',
      generateAudio: true,
      imageUrls: ['https://example.com/a.png', 'https://example.com/b.png'],
    })).toEqual({
      model: 'veo-omni',
      prompt: '参考人物生成视频',
      seconds: '10',
      aspect_ratio: '16:9',
      resolution: '720p',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: '参考人物生成视频' },
          { type: 'image_url', image_url: { url: 'https://example.com/a.png', detail: 'high' } },
          { type: 'image_url', image_url: { url: 'https://example.com/b.png', detail: 'high' } },
        ],
      }],
    })
  })

  it('uses the documented image array for video-v1 variants', () => {
    expect(buildPro666VideoRequest({
      model: 'video-v1-face',
      prompt: '人物微笑',
      duration: 5,
      aspectRatio: '1:1',
      imageUrls: ['https://example.com/face.png'],
    })).toEqual({
      model: 'video-v1-face',
      prompt: '人物微笑',
      duration: 5,
      aspect_ratio: '1:1',
      images: ['https://example.com/face.png'],
    })
  })

  it('reads metadata URLs but keeps authenticated content routes private', () => {
    expect(getPro666VideoContentUrl({ metadata: { url: 'https://cdn.example.com/result.mp4' } })).toBe('https://cdn.example.com/result.mp4')
    expect(normalizePro666VideoContentUrl('https://pro666.top/v1/videos/task_xxx/content')).toBe('')
    expect(normalizePro666VideoContentUrl('http://server.example/result.mp4')).toBe('')
  })

  it('submits requests to the Pro666 video endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ task_id: 'task-pro666' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await createPro666VideoTask('sk-pro666', { model: 'video-900', prompt: '生成视频' })

    expect(fetchMock).toHaveBeenCalledWith('https://api.pro666.top/v1/videos', {
      method: 'POST',
      headers: { Authorization: 'Bearer sk-pro666', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'video-900', prompt: '生成视频' }),
    })
  })

  it('sends authorization when downloading a protected returned URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('video', { status: 200, headers: { 'Content-Type': 'video/mp4' } }))
    vi.stubGlobal('fetch', fetchMock)

    await downloadProviderVideoContent('pro666', 'sk-pro666', 'task_xxx', 'https://pro666.top/v1/videos/task_xxx/content')

    expect(fetchMock).toHaveBeenCalledWith('https://pro666.top/v1/videos/task_xxx/content', {
      headers: { Authorization: 'Bearer sk-pro666' },
      cache: 'no-store',
    })
  })
})
