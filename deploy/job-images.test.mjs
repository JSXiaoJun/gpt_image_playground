import { describe, expect, it } from 'vitest'
import { extractJobImages, getJobImageUrls } from './job-images.mjs'

describe('persistent job image links', () => {
  it('extracts OpenAI base64 and URL results', () => {
    const images = extractJobImages(JSON.stringify({
      data: [
        { b64_json: 'YWJj', output_format: 'webp' },
        { url: 'https://example.com/image.png' },
      ],
    }))

    expect(images).toEqual([
      { base64: 'YWJj', mimeType: 'image/webp' },
      { url: 'https://example.com/image.png' },
    ])
  })

  it('only publishes image URLs after the job is done', () => {
    const job = { id: 'task 1', status: 'done', images: [{ base64: 'YWJj', mimeType: 'image/png' }] }
    expect(getJobImageUrls(job)).toEqual(['/api-jobs/task%201/images/0'])
    expect(getJobImageUrls({ ...job, status: 'running' })).toEqual([])
  })
})
