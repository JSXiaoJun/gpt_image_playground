import { describe, expect, it } from 'vitest'
import { getTaskOutputImageSources, getTaskOutputImageZipEntries } from './downloadImages'

describe('download image sources', () => {
  it('uses result URLs before images finish local persistence', () => {
    expect(getTaskOutputImageSources({
      outputImages: [],
      rawImageUrls: ['https://example.com/1.png', 'https://example.com/2.png'],
    })).toEqual(['https://example.com/1.png', 'https://example.com/2.png'])
  })

  it('prefers local images and fills unfinished slots from result URLs', () => {
    expect(getTaskOutputImageSources({
      outputImages: ['local-1'],
      rawImageUrls: ['https://example.com/1.png', 'https://example.com/2.png'],
    })).toEqual(['local-1', 'https://example.com/2.png'])
  })

  it('builds zip entries from both local and pending result images', () => {
    expect(getTaskOutputImageZipEntries([{
      id: 'task-a',
      createdAt: 1,
      outputImages: ['local-1'],
      rawImageUrls: ['https://example.com/1.png', 'https://example.com/2.png'],
    }])).toEqual([
      { imageId: 'local-1', fileNameBase: 'task-task-a-01' },
      { imageId: 'https://example.com/2.png', fileNameBase: 'task-task-a-02' },
    ])
  })
})
