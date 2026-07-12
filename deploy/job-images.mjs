function getMimeType(item, fallback = 'image/png') {
  if (typeof item?.mime_type === 'string' && item.mime_type.startsWith('image/')) return item.mime_type
  if (typeof item?.mimeType === 'string' && item.mimeType.startsWith('image/')) return item.mimeType
  const format = typeof item?.output_format === 'string' ? item.output_format.toLowerCase() : ''
  if (format === 'jpeg' || format === 'jpg') return 'image/jpeg'
  if (format === 'webp') return 'image/webp'
  return fallback
}

function addImage(output, value, mimeType) {
  if (typeof value !== 'string' || !value.trim()) return
  if (/^https?:\/\//i.test(value)) {
    output.push({ url: value })
    return
  }

  const dataUrl = value.match(/^data:(image\/[^;,]+);base64,(.+)$/s)
  output.push({
    base64: dataUrl ? dataUrl[2] : value,
    mimeType: dataUrl?.[1] || mimeType,
  })
}

export function extractJobImages(body) {
  let payload
  try {
    payload = JSON.parse(body)
  } catch {
    return []
  }

  const images = []
  for (const item of Array.isArray(payload?.data) ? payload.data : []) {
    const mimeType = getMimeType(item)
    if (item?.b64_json) addImage(images, item.b64_json, mimeType)
    else if (item?.url) addImage(images, item.url, mimeType)
  }

  for (const candidate of Array.isArray(payload?.candidates) ? payload.candidates : []) {
    for (const part of Array.isArray(candidate?.content?.parts) ? candidate.content.parts : []) {
      const inlineData = part?.inlineData || part?.inline_data
      if (inlineData?.data) addImage(images, inlineData.data, getMimeType(inlineData))
    }
  }
  return images
}

export function getJobImageUrls(job) {
  if (job.status !== 'done' || !Array.isArray(job.images)) return []
  return job.images.map((_, index) => `/api-jobs/${encodeURIComponent(job.id)}/images/${index}`)
}
