import { describe, expect, it, vi } from 'vitest'
import worker from './r2-assets.js'

function object(range) {
  return {
    body: 'png',
    size: 3,
    range,
    httpEtag: '"etag"',
    writeHttpMetadata(headers) {
      headers.set('Content-Type', 'image/png')
    },
  }
}

describe('r2 asset responses', () => {
  it('returns 200 for a regular asset request', async () => {
    const get = vi.fn().mockResolvedValue(object({ offset: 0, length: 3 }))

    const response = await worker.fetch(
      new Request('https://upload.onlyzhuya.xyz/asset/02fc40a7-8086-4bd0-ae0f-e6d77a0b1443.png'),
      { ASSETS_BUCKET: { get } },
    )

    expect(get).toHaveBeenCalledWith('temp/02fc40a7-8086-4bd0-ae0f-e6d77a0b1443.png')
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Range')).toBeNull()
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
  })

  it('returns 206 only when the client requests a byte range', async () => {
    const get = vi.fn().mockResolvedValue(object({ offset: 0, length: 2 }))
    const request = new Request(
      'https://upload.onlyzhuya.xyz/asset/02fc40a7-8086-4bd0-ae0f-e6d77a0b1443.png',
      { headers: { Range: 'bytes=0-1' } },
    )

    const response = await worker.fetch(request, { ASSETS_BUCKET: { get } })

    expect(get).toHaveBeenCalledWith('temp/02fc40a7-8086-4bd0-ae0f-e6d77a0b1443.png', { range: request.headers })
    expect(response.status).toBe(206)
    expect(response.headers.get('Content-Range')).toBe('bytes 0-1/3')
  })
})
