import { afterEach, describe, expect, it, vi } from 'vitest'
import { createVideoTask, downloadVideoContent, fetchVideoModelCapabilities, fetchVideoModels } from './videoApi'

afterEach(() => vi.unstubAllGlobals())

describe('videoApi', () => {
  it('maps the create payload and preserves task_id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ task_id: 'task-public', id: 'internal' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await createVideoTask('https://zl.yyapi.cloud/', 'sk-test', {
      model: 'gemini-omni-flash',
      prompt: '电影感运镜',
      aspectRatio: '16:9',
      duration: 8,
      resolution: '720p',
      generateAudio: true,
      imageUrls: ['https://example.com/a.png', 'https://example.com/b.png'],
    })

    expect(result.taskId).toBe('task-public')
    expect(fetchMock).toHaveBeenCalledWith('https://zl.yyapi.cloud/v1/videos', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        model: 'gemini-omni-flash',
        prompt: '电影感运镜',
        aspect_ratio: '16:9',
        duration: 8,
        resolution: '720p',
        generate_audio: true,
        image_urls: ['https://example.com/a.png', 'https://example.com/b.png'],
      }),
    }))
  })

  it('loads the live model list', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: 'sora2', owned_by: 'test' }, {}],
    }), { status: 200 })))

    await expect(fetchVideoModels('https://zl.yyapi.cloud', 'sk-test')).resolves.toEqual([
      { id: 'sora2', ownedBy: 'test' },
    ])
  })

  it('sends one canonical payload for model-specific middleware conversion', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ task_id: 'task-933' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await createVideoTask('https://zl.yyapi.cloud', 'sk-test', {
      model: 'manxue-933',
      prompt: '电影感角色短片',
      duration: 15,
      generateAudio: true,
      imageUrls: ['https://example.com/main.png'],
      referenceVideo: 'https://example.com/reference.mp4',
      audioUrls: ['https://example.com/voice.mp3'],
    })

    expect(fetchMock).toHaveBeenCalledWith('https://zl.yyapi.cloud/v1/videos', expect.objectContaining({
      body: JSON.stringify({
        model: 'manxue-933',
        prompt: '电影感角色短片',
        duration: 15,
        generate_audio: true,
        image_urls: ['https://example.com/main.png'],
        reference_video: 'https://example.com/reference.mp4',
        audio_urls: ['https://example.com/voice.mp3'],
      }),
    }))
  })

  it('loads and validates dynamic model capabilities', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [
        {
          id: 'manxue-900-10s',
          capabilities: {
            ratios: ['16:9'],
            durations: [10],
            resolutions: ['720p'],
            maxImages: 9,
            referenceVideo: true,
          },
        },
        { id: 'invalid', capabilities: {} },
      ],
    }), { status: 200 })))

    await expect(fetchVideoModelCapabilities('https://video-admin.yyapi.cloud')).resolves.toEqual([
      {
        id: 'manxue-900-10s',
        capabilities: {
          ratios: ['16:9'],
          durations: [10],
          resolutions: ['720p'],
          maxImages: 9,
          referenceVideo: true,
        },
      },
    ])
  })

  it('rejects JSON returned from the content endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })))

    await expect(downloadVideoContent('https://zl.yyapi.cloud', 'sk-test', 'task-1')).rejects.toThrow('视频响应类型无效')
  })
})
