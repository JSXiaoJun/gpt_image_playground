import { afterEach, describe, expect, it, vi } from 'vitest'
import { createVideoTask, downloadVideoContent, fetchVideoCatalog, fetchVideoModelCapabilities, getVideoContentUrl, normalizeVideoProgress, normalizeVideoTaskStatus } from './videoApi'

afterEach(() => vi.unstubAllGlobals())

describe('videoApi', () => {
  it.each(['16:9', '9:16'])('maps Omni %s into metadata and preserves task_id', async (aspectRatio) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ task_id: 'task-public', id: 'internal' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await createVideoTask('https://video-admin.yyapi.cloud/new-api/', 'sk-test', {
      model: 'gemini-omni-flash',
      prompt: '电影感运镜',
      aspectRatio,
      duration: 8,
      resolution: '720p',
      generateAudio: true,
      imageUrls: ['https://example.com/a.png', 'https://example.com/b.png'],
    })

    expect(result.taskId).toBe('task-public')
    expect(fetchMock).toHaveBeenCalledWith('https://video-admin.yyapi.cloud/new-api/v1/videos', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        model: 'gemini-omni-flash',
        prompt: '电影感运镜',
        metadata: { aspect_ratio: aspectRatio },
        duration: 8,
        resolution: '720P',
        generate_audio: true,
        image_urls: ['https://example.com/a.png', 'https://example.com/b.png'],
      }),
    }))
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
      aspectRatio: '16:9',
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
        aspect_ratio: '16:9',
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

  it('loads the complete catalog from middleware without an API key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
        data: [{
          id: 'gemini-omni-flash',
          capabilities: {
            ratios: ['16:9'],
            durations: [10],
            resolutions: ['720p'],
            maxImages: 5,
            referenceVideo: true,
          },
        }],
      }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchVideoCatalog('https://video-admin.yyapi.cloud')).resolves.toEqual({
      models: ['gemini-omni-flash'],
      capabilities: [{
        id: 'gemini-omni-flash',
        capabilities: {
          ratios: ['16:9'],
          durations: [10],
          resolutions: ['720p'],
          maxImages: 5,
          referenceVideo: true,
        },
      }],
    })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledWith('https://video-admin.yyapi.cloud/v1/model-capabilities', {
      cache: 'no-store',
    })
  })

  it('rejects JSON returned from the content endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })))

    await expect(downloadVideoContent('https://zl.yyapi.cloud', 'sk-test', 'task-1')).rejects.toThrow('视频响应类型无效')
  })

  it('downloads a returned public media URL without sending the API key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('video', {
      status: 200,
      headers: { 'content-type': 'video/mp4' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await downloadVideoContent(
      'https://zl.yyapi.cloud',
      'sk-test',
      'task_test_1',
      'https://media.yyapi.cloud/public/videos/task_test_1/content',
    )

    expect(fetchMock).toHaveBeenCalledWith(
      'https://media.yyapi.cloud/public/videos/task_test_1/content',
      { cache: 'no-store' },
    )
  })

  it('keeps the authenticated fallback for historical tasks without a public URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('video', {
      status: 200,
      headers: { 'content-type': 'video/mp4' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await downloadVideoContent('https://zl.yyapi.cloud', 'sk-test', 'task-1')

    expect(fetchMock).toHaveBeenCalledWith(
      'https://zl.yyapi.cloud/v1/videos/task-1/content',
      { headers: { Authorization: 'Bearer sk-test' }, cache: 'no-store' },
    )
  })

  it('normalizes legacy New API public links to the dedicated media domain', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('video', {
      status: 200,
      headers: { 'content-type': 'video/mp4' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const legacyUrl = 'https://www.yyapi.cloud/public/videos/task_legacy/content'
    expect(getVideoContentUrl({ video_url: legacyUrl })).toBe(
      'https://media.yyapi.cloud/public/videos/task_legacy/content',
    )
    await downloadVideoContent('https://zl.yyapi.cloud', 'sk-test', 'task_legacy', legacyUrl)

    expect(fetchMock).toHaveBeenCalledWith(
      'https://media.yyapi.cloud/public/videos/task_legacy/content',
      { cache: 'no-store' },
    )
  })

  it('extracts the public URL from the completed video response', () => {
    const url = 'https://media.yyapi.cloud/public/videos/task_6OSxUguPhQYjPPo0Ziv7frPGTqbOIftU/content'
    const task = {
      object: 'video',
      model: 'gemini-omni-flash',
      status: 'completed',
      progress: 100,
      created_at: 1786602631,
      updated_at: 1786602760,
      error: null,
      video_url: url,
      url,
      result_url: url,
      download_url: url,
    }

    expect(normalizeVideoTaskStatus(task.status)).toBe('completed')
    expect(normalizeVideoProgress(task.progress)).toBe(100)
    expect(getVideoContentUrl(task)).toBe(url)
  })

  it('rejects raw upstream and malformed public video URLs', () => {
    expect(getVideoContentUrl({ video_url: 'https://asset.example/video.mp4' })).toBeUndefined()
    expect(getVideoContentUrl({ video_url: 'https://media.yyapi.cloud/public/videos/not-public/content' })).toBeUndefined()
    expect(getVideoContentUrl({ video_url: 'javascript:alert(1)' })).toBeUndefined()
  })

  it('normalizes task status aliases and string progress values', () => {
    expect(normalizeVideoTaskStatus('SUCCESS')).toBe('completed')
    expect(normalizeVideoTaskStatus('succeeded')).toBe('completed')
    expect(normalizeVideoTaskStatus('IN_PROGRESS')).toBe('processing')
    expect(normalizeVideoTaskStatus('running')).toBe('processing')
    expect(normalizeVideoTaskStatus('FAILURE')).toBe('failed')
    expect(normalizeVideoTaskStatus('cancelled')).toBe('failed')
    expect(normalizeVideoTaskStatus('pending')).toBe('queued')
    expect(normalizeVideoProgress('72.6%')).toBe(73)
    expect(normalizeVideoProgress(120)).toBe(100)
    expect(normalizeVideoProgress('invalid', 25)).toBe(25)
  })

  it.each([
    ['video/mp4', null, 'mp4'],
    ['video/webm', null, 'webm'],
    ['video/quicktime', null, 'mov'],
    ['video/mpeg', null, 'mpeg'],
    ['video/ogg', null, 'ogv'],
    ['video/x-msvideo', null, 'avi'],
    ['video/x-matroska', null, 'mkv'],
    ['video/3gpp', null, '3gp'],
    ['video/3gpp2', null, '3g2'],
    ['application/octet-stream', 'attachment; filename="result.webm"', 'webm'],
    ['application/octet-stream', null, 'mp4'],
  ])('accepts %s video responses and chooses .%s', async (contentType, contentDisposition, extension) => {
    const headers = new Headers({ 'content-type': contentType })
    if (contentDisposition) headers.set('content-disposition', contentDisposition)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('video', { status: 200, headers })))

    const result = await downloadVideoContent('https://zl.yyapi.cloud', 'sk-test', 'task-format')

    expect(result.extension).toBe(extension)
  })
})
