const ALLOWED_ORIGIN = 'https://image.yyapi.cloud'
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024
const MAX_REQUESTS_PER_WINDOW = 10
const RATE_WINDOW_MS = 24 * 60 * 60 * 1000

const recentUploads = new Map()

function corsHeaders(origin) {
  const headers = new Headers({
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS, PUT',
    'Access-Control-Allow-Headers': 'Content-Type, X-File-Size',
    'Access-Control-Expose-Headers': 'ETag',
    'Access-Control-Max-Age': '3600',
    Vary: 'Origin',
  })
  if (origin === ALLOWED_ORIGIN) headers.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN)
  return headers
}

function json(data, status, origin) {
  const headers = corsHeaders(origin)
  headers.set('Content-Type', 'application/json; charset=utf-8')
  headers.set('Cache-Control', 'no-store')
  return new Response(JSON.stringify(data), { status, headers })
}

function clientKey(request) {
  return request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown'
}

function consumeRateLimit(request) {
  const key = clientKey(request)
  const now = Date.now()
  const current = recentUploads.get(key)
  if (!current || now - current.startedAt >= RATE_WINDOW_MS) {
    recentUploads.set(key, { startedAt: now, count: 1 })
    return true
  }
  if (current.count >= MAX_REQUESTS_PER_WINDOW) return false
  current.count += 1
  return true
}

function getObjectKey(pathname) {
  const match = pathname.match(/^\/asset\/([^/]+)$/)
  if (!match || !/^[a-f0-9-]{36}\.(?:png|jpe?g|webp|gif|mp4|webm|mov|mp3|wav|m4a|ogg|aac)$/i.test(match[1])) return null
  return `temp/${match[1]}`
}

function extensionFor(contentType) {
  const type = contentType.toLowerCase().split(';', 1)[0]
  if (type === 'image/png') return 'png'
  if (type === 'image/jpeg') return 'jpg'
  if (type === 'image/webp') return 'webp'
  if (type === 'image/gif') return 'gif'
  if (type === 'video/mp4') return 'mp4'
  if (type === 'video/webm') return 'webm'
  if (type === 'video/quicktime') return 'mov'
  if (type === 'audio/mpeg') return 'mp3'
  if (type === 'audio/wav' || type === 'audio/x-wav') return 'wav'
  if (type === 'audio/mp4' || type === 'audio/x-m4a') return 'm4a'
  if (type === 'audio/ogg') return 'ogg'
  if (type === 'audio/aac') return 'aac'
  return null
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const origin = request.headers.get('Origin') || ''

    if (request.method === 'OPTIONS') {
      if (origin !== ALLOWED_ORIGIN) return new Response(null, { status: 403 })
      return new Response(null, { status: 204, headers: corsHeaders(origin) })
    }

    if (url.pathname === '/health' && request.method === 'GET') {
      return json({ ok: true }, 200, origin)
    }

    if (url.pathname === '/upload' && request.method === 'PUT') {
      if (origin !== ALLOWED_ORIGIN) return json({ error: 'Origin not allowed' }, 403, origin)
      if (!consumeRateLimit(request)) return json({ error: 'Upload limit reached. Try again tomorrow.' }, 429, origin)

      const contentType = request.headers.get('Content-Type') || ''
      const extension = extensionFor(contentType)
      if (!extension) return json({ error: 'Unsupported image, video or audio format.' }, 415, origin)

      const contentLength = Number(request.headers.get('X-File-Size') || request.headers.get('Content-Length') || 0)
      if (!Number.isFinite(contentLength) || contentLength <= 0 || contentLength > MAX_UPLOAD_BYTES) {
        return json({ error: 'File is empty or exceeds the 100 MB limit.' }, 413, origin)
      }

      const id = crypto.randomUUID()
      const key = `temp/${id}.${extension}`
      await env.ASSETS_BUCKET.put(key, request.body, {
        httpMetadata: { contentType },
        customMetadata: { origin, uploadedAt: new Date().toISOString() },
      })
      return json({ key, url: `${url.origin}/asset/${id}.${extension}` }, 201, origin)
    }

    const key = getObjectKey(url.pathname)
    if (key && (request.method === 'GET' || request.method === 'HEAD')) {
      const object = await env.ASSETS_BUCKET.get(key)
      if (!object) return new Response('Not found', { status: 404 })
      const headers = new Headers(corsHeaders(origin))
      object.writeHttpMetadata(headers)
      headers.set('Cache-Control', 'private, max-age=3600')
      headers.set('ETag', object.httpEtag)
      return new Response(request.method === 'HEAD' ? null : object.body, { status: 200, headers })
    }

    return json({ error: 'Not found' }, 404, origin)
  },
}
