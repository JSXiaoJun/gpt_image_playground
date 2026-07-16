import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchWithPersistentProxy, readPersistentProxyJob } from './persistentProxyFetch'

describe('persistent proxy job reads', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('requests a body-free summary for existence checks', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: 'task-1',
      status: 'done',
      phase: 'done',
      responseBytes: 20_000_000,
      response: null,
    }), {
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const job = await readPersistentProxyJob('task-1', undefined, true)

    expect(fetchMock).toHaveBeenCalledWith('/api-jobs/task-1?summary=1', {
      cache: 'no-store',
      signal: expect.any(AbortSignal),
    })
    expect(job).not.toBeNull()
    expect(job!.status).toBe('done')
    expect(job!.response).toBeNull()
  })

  it('returns shareable absolute result and image URLs in the browser', async () => {
    vi.stubGlobal('window', { location: { origin: 'https://image.example.com' } })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      id: 'task-1',
      status: 'done',
      resultUrl: '/api-jobs/task-1/result',
      imageUrls: ['/api-jobs/task-1/images/0'],
    }))))

    const job = await readPersistentProxyJob('task-1', undefined, true)

    expect(job?.resultUrl).toBe('https://image.example.com/api-jobs/task-1/result')
    expect(job?.imageUrls).toEqual(['https://image.example.com/api-jobs/task-1/images/0'])
  })

  it('hands multipart requests to the persistent job server', async () => {
    vi.stubEnv('VITE_DOCKER_DEPLOYMENT', 'true')
    vi.stubEnv('VITE_API_PROXY_AVAILABLE', 'true')
    const formData = new FormData()
    formData.append('prompt', 'edit image')
    formData.append('image[]', new Blob(['image'], { type: 'image/png' }), 'input.png')
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'task-edit',
        status: 'running',
        phase: 'pending',
      }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'task-edit',
        status: 'done',
        phase: 'done',
        imageUrls: ['/api-jobs/task-edit/images/0'],
      }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const response = await fetchWithPersistentProxy('https://zl.yyapi.cloud/v1/images/edits', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-key' },
      body: formData,
    }, 'task-edit', 600)

    const [url, init] = fetchMock.mock.calls[0]
    const headers = new Headers((init as RequestInit).headers)
    expect(String(url)).toContain('/api-jobs/task-edit?raw=1')
    expect(String(url)).toContain(encodeURIComponent('/api-proxy/v1/images/edits'))
    expect((init as RequestInit).body).toBe(formData)
    expect(JSON.parse(decodeURIComponent(headers.get('x-job-forward-headers') || ''))).toEqual({
      authorization: 'Bearer test-key',
    })
    await expect(response.json()).resolves.toEqual({
      data: [{ url: '/api-jobs/task-edit/images/0' }],
    })
  })

  it('continues polling after a stuck status request times out', async () => {
    vi.useFakeTimers()
    vi.stubEnv('VITE_DOCKER_DEPLOYMENT', 'true')
    vi.stubEnv('VITE_API_PROXY_AVAILABLE', 'true')
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'task-retry',
        status: 'running',
        phase: 'pending',
      }), { status: 202 }))
      .mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
        const signal = (init as RequestInit).signal
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'task-retry',
        status: 'done',
        phase: 'done',
        imageUrls: ['/api-jobs/task-retry/images/0'],
      })))
    vi.stubGlobal('fetch', fetchMock)

    const responsePromise = fetchWithPersistentProxy('https://zl.yyapi.cloud/v1/images/generations', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-key' },
      body: JSON.stringify({ prompt: 'test' }),
    }, 'task-retry', 600)

    await vi.advanceTimersByTimeAsync(11_000)
    const response = await responsePromise

    expect(fetchMock).toHaveBeenCalledTimes(3)
    await expect(response.json()).resolves.toEqual({
      data: [{ url: '/api-jobs/task-retry/images/0' }],
    })
  })
})
