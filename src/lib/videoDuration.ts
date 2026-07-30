const VIDEO_METADATA_TIMEOUT_MS = 15_000

function getMediaDuration(source: string | File, kind: 'audio' | 'video') {
  return new Promise<number>((resolve, reject) => {
    const media = document.createElement(kind)
    const src = typeof source === 'string' ? source : URL.createObjectURL(source)
    const objectUrl = typeof source === 'string' ? null : src
    const cleanup = () => {
      clearTimeout(timer)
      media.onloadedmetadata = null
      media.onerror = null
      media.removeAttribute('src')
      media.load()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
    const timer = window.setTimeout(() => {
      cleanup()
      reject(new Error(`读取${kind === 'audio' ? '音频' : '视频'}时长超时`))
    }, VIDEO_METADATA_TIMEOUT_MS)

    media.preload = 'metadata'
    media.onloadedmetadata = () => {
      const duration = media.duration
      cleanup()
      if (!Number.isFinite(duration) || duration <= 0) {
        reject(new Error(`无法读取${kind === 'audio' ? '音频' : '视频'}时长`))
        return
      }
      resolve(duration)
    }
    media.onerror = () => {
      cleanup()
      reject(new Error(`无法读取${kind === 'audio' ? '音频' : '视频'}时长，请确认链接可以直接访问`))
    }
    media.src = src
  })
}

export function getVideoDuration(source: string | File) {
  return getMediaDuration(source, 'video')
}

export function getAudioDuration(source: string | File) {
  return getMediaDuration(source, 'audio')
}
