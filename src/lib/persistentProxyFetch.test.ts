import { afterEach, describe, expect, it, vi } from 'vitest'
import { readPersistentProxyJob } from './persistentProxyFetch'

describe('persistent proxy job reads', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
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
      signal: undefined,
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
})
