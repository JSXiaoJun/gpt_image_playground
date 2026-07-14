import { zipSync } from 'fflate'
import type { TaskRecord } from '../types'
import { getImage } from './db'
import { dataUrlToBytes } from './dataUrl'
import { getNumberedFileNameBase, sanitizeFileNamePart } from './exportFileName'

const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

export interface DownloadImagesResult {
  successCount: number
  failCount: number
}

export interface DownloadImageZipEntry {
  imageId: string
  fileNameBase?: string
}

type TaskOutputZipTask = Pick<TaskRecord, 'id' | 'createdAt' | 'outputImages' | 'rawImageUrls'>
type TaskOutputSources = Pick<TaskRecord, 'outputImages' | 'rawImageUrls'>

export { formatExportFileTime } from './exportFileName'

export async function downloadImageIds(imageIds: string[], fileNameBase = 'images'): Promise<DownloadImagesResult> {
  if (imageIds.length === 0) return { successCount: 0, failCount: 0 }

  let successCount = 0
  let failCount = 0
  const multiple = imageIds.length > 1

  for (let index = 0; index < imageIds.length; index++) {
    try {
      const blob = await getImageBlob(imageIds[index])
      const order = String(index + 1).padStart(2, '0')
      const fileName = multiple
        ? `${fileNameBase}-${order}.${getBlobExtension(blob)}`
        : `${fileNameBase}.${getBlobExtension(blob)}`
      triggerDownload(blob, fileName)
      successCount++
      if (multiple) await delay(100)
    } catch (err) {
      console.error(err)
      failCount++
    }
  }

  return { successCount, failCount }
}

export async function downloadImageEntriesAsZip(entries: DownloadImageZipEntry[], zipFileNameBase = 'images'): Promise<DownloadImagesResult> {
  if (entries.length === 0) return { successCount: 0, failCount: 0 }

  let successCount = 0
  let failCount = 0
  const zipFiles: Record<string, Uint8Array | [Uint8Array, { mtime: Date }]> = {}
  const usedNames = new Set<string>()

  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]
    try {
      const image = await getImageBytes(entry.imageId)
      const order = String(index + 1).padStart(2, '0')
      const base = sanitizeFileNamePart(entry.fileNameBase || `image-${order}`) || `image-${order}`
      const ext = getMimeExtension(image.mimeType)
      let fileName = `${base}.${ext}`
      let duplicateIndex = 2
      while (usedNames.has(fileName)) {
        fileName = `${base}-${String(duplicateIndex).padStart(2, '0')}.${ext}`
        duplicateIndex++
      }
      usedNames.add(fileName)
      zipFiles[fileName] = [image.bytes, { mtime: new Date() }]
      successCount++
    } catch (err) {
      console.error(err)
      failCount++
    }
  }

  if (successCount > 0) {
    // PNG/JPEG/WebP 已经压缩，再做 Deflate 只会消耗大量 CPU，几乎不减小体积。
    const zipped = zipSync(zipFiles, { level: 0 })
    const buffer = zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength) as ArrayBuffer
    triggerDownload(new Blob([buffer], { type: 'application/zip' }), `${sanitizeFileNamePart(zipFileNameBase) || 'images'}.zip`)
  }

  return { successCount, failCount }
}

export function getTaskOutputImageZipEntries(tasks: TaskOutputZipTask[]): DownloadImageZipEntry[] {
  return [...tasks]
    .sort((a, b) => b.createdAt - a.createdAt)
    .flatMap((task) => getImageZipEntries(getTaskOutputImageSources(task), `task-${task.id}`))
}

export function getTaskOutputImageSources(task: TaskOutputSources): string[] {
  const count = Math.max(task.outputImages.length, task.rawImageUrls?.length ?? 0)
  return Array.from({ length: count }, (_, index) => task.outputImages[index] || task.rawImageUrls?.[index] || '')
    .filter(Boolean)
}

export function getImageZipEntries(imageIds: string[], fileNameBase = 'image'): DownloadImageZipEntry[] {
  return imageIds.map((imageId, index) => ({
    imageId,
    fileNameBase: getNumberedFileNameBase(fileNameBase, index, imageIds.length),
  }))
}

async function getImageBlob(imageIdOrUrl: string): Promise<Blob> {
  const image = await getImageBytes(imageIdOrUrl)
  const buffer = image.bytes.buffer.slice(image.bytes.byteOffset, image.bytes.byteOffset + image.bytes.byteLength) as ArrayBuffer
  return new Blob([buffer], { type: image.mimeType })
}

async function getImageBytes(imageIdOrUrl: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
  if (!imageIdOrUrl.startsWith('data:') && !imageIdOrUrl.startsWith('http://') && !imageIdOrUrl.startsWith('https://')) {
    const image = await getImage(imageIdOrUrl)
    if (!image) throw new Error(`读取图片失败：${imageIdOrUrl}`)
    const decoded = dataUrlToBytes(image.dataUrl)
    const mimeType = image.dataUrl.match(/^data:([^;,]+)/)?.[1] || `image/${decoded.ext}`
    return { bytes: decoded.bytes, mimeType }
  }

  if (imageIdOrUrl.startsWith('data:')) {
    const decoded = dataUrlToBytes(imageIdOrUrl)
    const mimeType = imageIdOrUrl.match(/^data:([^;,]+)/)?.[1] || `image/${decoded.ext}`
    return { bytes: decoded.bytes, mimeType }
  }

  const response = await fetch(imageIdOrUrl)
  if (!response.ok) throw new Error(`读取图片失败：${imageIdOrUrl}`)
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    mimeType: response.headers.get('content-type')?.split(';')[0] || 'image/png',
  }
}

function triggerDownload(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

function getBlobExtension(blob: Blob): string {
  return getMimeExtension(blob.type)
}

function getMimeExtension(mimeType: string): string {
  return MIME_EXTENSIONS[mimeType.toLowerCase()] ?? mimeType.split('/')[1] ?? 'png'
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

