import { afterEach, describe, expect, it, vi } from 'vitest'
import { uploadR2Asset } from './r2AssetUpload'

describe('uploadR2Asset', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns the URL after verifying the uploaded object size', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ url: 'https://upload.onlyzhuya.xyz/asset/test.jpg' }), { status: 201 }))
      .mockResolvedValueOnce(new Response(null, { status: 200, headers: { 'Content-Length': '3' } }))
    vi.stubGlobal('fetch', fetchMock)

    const file = new File(['jpg'], 'test.jpg', { type: 'image/jpeg' })

    await expect(uploadR2Asset(file)).resolves.toBe('https://upload.onlyzhuya.xyz/asset/test.jpg')
    expect(fetchMock).toHaveBeenLastCalledWith('https://upload.onlyzhuya.xyz/asset/test.jpg', {
      method: 'HEAD',
      cache: 'no-store',
      signal: undefined,
    })
  })

  it('retries when the upload connection is interrupted', async () => {
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
      fn()
      return 0
    }) as typeof setTimeout)
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ url: 'https://upload.onlyzhuya.xyz/asset/test.jpg' }), { status: 201 }))
      .mockResolvedValueOnce(new Response(null, { status: 200, headers: { 'Content-Length': '3' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(uploadR2Asset(new File(['jpg'], 'test.jpg', { type: 'image/jpeg' }))).resolves.toBe(
      'https://upload.onlyzhuya.xyz/asset/test.jpg',
    )
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('does not retry a rejected file type response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Unsupported format' }), { status: 415 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(uploadR2Asset(new File(['jpg'], 'test.jpg', { type: 'image/jpeg' }))).rejects.toThrow('Unsupported format')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('rejects an uploaded object with the wrong size after three attempts', async () => {
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
      fn()
      return 0
    }) as typeof setTimeout)
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ url: 'https://upload.onlyzhuya.xyz/asset/test.jpg' }), { status: 201 }))
      .mockResolvedValue(new Response(null, { status: 200, headers: { 'Content-Length': '2' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(uploadR2Asset(new File(['jpg'], 'test.jpg', { type: 'image/jpeg' }))).rejects.toThrow(
      '上传后的文件校验失败，请重试',
    )
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })
})
