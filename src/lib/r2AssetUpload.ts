export const R2_ASSET_WORKER_URL = 'https://upload.onlyzhuya.xyz'
export const MAX_R2_UPLOAD_BYTES = 100 * 1024 * 1024

const ALLOWED_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
  'audio/mp4',
  'audio/x-m4a',
  'audio/ogg',
  'audio/aac',
])

export async function uploadR2Asset(file: File, signal?: AbortSignal) {
  if (!ALLOWED_TYPES.has(file.type)) throw new Error('不支持当前图片、视频或音频格式')
  if (file.size <= 0 || file.size > MAX_R2_UPLOAD_BYTES) throw new Error('文件为空或超过 100 MB 限制')

  let url = ''
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response: Response
    try {
      response = await fetch(`${R2_ASSET_WORKER_URL}/upload`, {
        method: 'PUT',
        headers: {
          'Content-Type': file.type,
          'X-File-Size': String(file.size),
        },
        body: file,
        signal,
      })
    } catch (err) {
      if (signal?.aborted || attempt === 2) throw err
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)))
      continue
    }

    const payload = await response.json().catch(() => null) as { url?: unknown; error?: unknown } | null
    if (!response.ok || typeof payload?.url !== 'string') {
      const message = typeof payload?.error === 'string' ? payload.error : `上传失败（HTTP ${response.status}）`
      if (response.status < 500 && response.status !== 429) throw new Error(message)
      if (attempt === 2) throw new Error(message)
    } else {
      url = payload.url
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)))
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const check = await fetch(url, { method: 'HEAD', cache: 'no-store', signal })
      if (check.ok && Number(check.headers.get('Content-Length')) === file.size) return url
      if (attempt === 2) throw new Error('上传后的文件校验失败，请重试')
    } catch (err) {
      if (signal?.aborted || attempt === 2) throw err
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)))
  }

  throw new Error('上传后的文件校验失败，请重试')
}
