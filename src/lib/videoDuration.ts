const VIDEO_METADATA_TIMEOUT_MS = 15_000

export function getVideoDuration(source: string | File) {
  return new Promise<number>((resolve, reject) => {
    const video = document.createElement('video')
    const src = typeof source === 'string' ? source : URL.createObjectURL(source)
    const objectUrl = typeof source === 'string' ? null : src
    const cleanup = () => {
      clearTimeout(timer)
      video.onloadedmetadata = null
      video.onerror = null
      video.removeAttribute('src')
      video.load()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
    const timer = window.setTimeout(() => {
      cleanup()
      reject(new Error('读取视频时长超时'))
    }, VIDEO_METADATA_TIMEOUT_MS)

    video.preload = 'metadata'
    video.onloadedmetadata = () => {
      const duration = video.duration
      cleanup()
      if (!Number.isFinite(duration) || duration <= 0) {
        reject(new Error('无法读取视频时长'))
        return
      }
      resolve(duration)
    }
    video.onerror = () => {
      cleanup()
      reject(new Error('无法读取视频时长，请确认链接可以直接访问'))
    }
    video.src = src
  })
}
