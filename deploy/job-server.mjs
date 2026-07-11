import http from 'node:http'
import { readUpstreamResponseBody } from './read-upstream-body.mjs'

const host = process.env.JOB_SERVER_HOST || '127.0.0.1'
const port = Number(process.env.JOB_SERVER_PORT || 8787)
const rawJobTtl = Number(process.env.JOB_TTL_MS || 2 * 60 * 60 * 1000)
const normalizedJobTtlMs = rawJobTtl > 0 && rawJobTtl < 10_000 ? rawJobTtl * 1000 : rawJobTtl
const jobTtlMs = Math.max(10 * 60 * 1000, Number.isFinite(normalizedJobTtlMs) ? normalizedJobTtlMs : 2 * 60 * 60 * 1000)
const rawUpstreamTimeout = Number(process.env.JOB_UPSTREAM_TIMEOUT_MS || 0)
const normalizedUpstreamTimeoutMs = rawUpstreamTimeout > 0 && rawUpstreamTimeout < 10_000 ? rawUpstreamTimeout * 1000 : rawUpstreamTimeout
const upstreamTimeoutMs = Number.isFinite(normalizedUpstreamTimeoutMs) && normalizedUpstreamTimeoutMs > 0
  ? Math.max(30 * 1000, normalizedUpstreamTimeoutMs)
  : 0
const rawPendingTimeout = Number(process.env.JOB_PENDING_TIMEOUT_MS || 180 * 1000)
const normalizedPendingTimeoutMs = rawPendingTimeout > 0 && rawPendingTimeout < 10_000 ? rawPendingTimeout * 1000 : rawPendingTimeout
const pendingTimeoutMs = Number.isFinite(normalizedPendingTimeoutMs) && normalizedPendingTimeoutMs > 0
  ? Math.max(30 * 1000, normalizedPendingTimeoutMs)
  : 0
const imageInlineTimeoutMs = 8_000
const jobs = new Map()
const serverLogs = []

function addServerLog(level, source, message, data = {}) {
  const entry = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    time: new Date().toISOString(),
    level,
    source,
    message,
    data,
  }
  serverLogs.push(entry)
  while (serverLogs.length > 1000) serverLogs.shift()
  const line = `[${entry.time}] [${level}] [${source}] ${message} ${JSON.stringify(data)}`
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function getProxyBaseUrl() {
  const raw = process.env.API_PROXY_URL || process.env.API_URL || 'https://www.yyapi.cloud'
  const input = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(raw) ? raw : `https://${raw}`
  const url = new URL(input)
  const pathname = url.pathname.replace(/\/+$/, '')
  if (pathname === '/v1') return url.origin
  return `${url.origin}${pathname}`
}

function buildTargetUrl(proxiedUrl) {
  const rawPath = String(proxiedUrl || '')
  if (!rawPath.startsWith('/api-proxy/')) throw new Error('仅支持 /api-proxy/ 任务')

  const path = rawPath.replace(/^\/api-proxy\/+/, '')
  if (!path || path.includes('..') || path.startsWith('/')) throw new Error('代理路径无效')
  if (!/^v\d+(?:beta)?\//.test(path)) throw new Error('代理路径必须以 API 版本开头')

  const base = getProxyBaseUrl().replace(/\/+$/, '')
  return `${base}/${path}`
}

function normalizeHeaders(input) {
  const headers = {}
  if (!input || typeof input !== 'object') return headers

  for (const [key, value] of Object.entries(input)) {
    const lower = key.toLowerCase()
    if (lower === 'host' || lower === 'content-length' || lower === 'connection') continue
    if (typeof value === 'string') headers[key] = value
  }
  return headers
}

function isHttpUrl(value) {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

async function inlineImageUrlsInResponseBody(body) {
  let payload
  try {
    payload = JSON.parse(body)
  } catch {
    return { body, count: 0, urlCount: 0 }
  }

  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.data)) {
    return { body, count: 0, urlCount: 0 }
  }

  let count = 0
  const urlItems = payload.data.filter((item) => item && typeof item === 'object' && !item.b64_json && isHttpUrl(item.url))
  await Promise.all(payload.data.map(async (item) => {
    if (!item || typeof item !== 'object' || item.b64_json || !isHttpUrl(item.url)) return
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('image url inline timeout')), imageInlineTimeoutMs)
    try {
      const response = await fetch(item.url, {
        headers: {
          accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
          'user-agent': 'gpt-image-playground-image-proxy/1.0',
        },
        signal: controller.signal,
      })
      if (!response.ok) return
      const contentType = response.headers.get('content-type') || ''
      if (!contentType.toLowerCase().startsWith('image/')) return
      item.b64_json = Buffer.from(await response.arrayBuffer()).toString('base64')
      count += 1
  } catch (err) {
      addServerLog('warn', 'server:inline-url', '图片 URL 内联失败', { error: err instanceof Error ? err.message : String(err), url: item.url })
    } finally {
      clearTimeout(timer)
    }
  }))

  return { body: count > 0 ? JSON.stringify(payload) : body, count, urlCount: urlItems.length }
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    phase: job.phase,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    upstreamStatus: job.upstreamStatus,
    upstreamElapsedMs: job.upstreamElapsedMs,
    responseBytes: job.responseBytes,
    response: job.response,
    error: job.error,
  }
}

async function proxyImage(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`)
  const rawUrl = requestUrl.searchParams.get('url') || ''
  const targetUrl = new URL(rawUrl)
  if (targetUrl.protocol !== 'https:' && targetUrl.protocol !== 'http:') throw new Error('图片链接协议无效')

  const response = await fetch(targetUrl, {
    headers: {
      accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      'user-agent': 'gpt-image-playground-image-proxy/1.0',
    },
  })
  if (!response.ok) {
    sendJson(res, response.status, { error: `图片加载失败：HTTP ${response.status}` })
    return
  }

  const contentType = response.headers.get('content-type') || 'application/octet-stream'
  if (!contentType.toLowerCase().startsWith('image/')) throw new Error('目标链接不是图片响应')

  const body = Buffer.from(await response.arrayBuffer())
  res.writeHead(200, {
    'content-type': contentType,
    'cache-control': 'public, max-age=86400',
    'content-length': body.length,
  })
  res.end(body)
}

function startJob(id, payload) {
  const now = Date.now()
  const controller = new AbortController()
  const job = {
    id,
    status: 'running',
    phase: 'pending',
    createdAt: now,
    updatedAt: now,
    upstreamStatus: null,
    upstreamElapsedMs: null,
    responseBytes: null,
    response: null,
    error: null,
    controller,
  }
  jobs.set(id, job)

  const targetUrl = buildTargetUrl(payload.url)
  const headers = normalizeHeaders(payload.headers)
  const method = String(payload.method || 'POST').toUpperCase()
  const body = method === 'GET' || method === 'HEAD'
    ? undefined
    : typeof payload.body === 'string' ? payload.body : undefined
  let requestSummary = {}
  try {
    const parsedBody = body ? JSON.parse(body) : {}
    requestSummary = {
      model: parsedBody.model,
      size: parsedBody.size,
      quality: parsedBody.quality,
      n: parsedBody.n,
      stream: parsedBody.stream,
      response_format: parsedBody.response_format,
      promptLength: typeof parsedBody.prompt === 'string' ? parsedBody.prompt.length : undefined,
    }
  } catch {
    requestSummary = { bodyLength: body?.length ?? 0 }
  }
  const payloadTimeoutMs = Number(payload.timeoutMs)
  const effectiveUpstreamTimeoutMs = Number.isFinite(payloadTimeoutMs) && payloadTimeoutMs > 0
    ? Math.max(30 * 1000, payloadTimeoutMs)
    : upstreamTimeoutMs

  addServerLog('info', 'server:job', '任务开始', { id, method, targetUrl, timeoutMs: effectiveUpstreamTimeoutMs, pendingTimeoutMs, request: requestSummary })
  const upstreamTimeout = effectiveUpstreamTimeoutMs > 0
    ? setTimeout(() => {
        controller.abort(new Error(`上游请求超过 ${Math.round(effectiveUpstreamTimeoutMs / 1000)} 秒仍未返回`))
      }, effectiveUpstreamTimeoutMs)
    : null
  const pendingTimeout = pendingTimeoutMs > 0
    ? setTimeout(() => {
        if (job.phase !== 'pending') return
        controller.abort(new Error(`上游请求已提交，但 ${Math.round(pendingTimeoutMs / 1000)} 秒内没有返回 HTTP 响应头。NewAPI 后台可能已生成/扣费，但当前 HTTP 连接没有把结果返回给本服务。任务 ID：${id}`))
      }, pendingTimeoutMs)
    : null
  const heartbeat = setInterval(() => {
    if (job.status !== 'running') return
    addServerLog('debug', 'server:job', '任务仍在等待上游响应', {
      id,
      phase: job.phase,
      elapsedMs: Date.now() - now,
      upstreamStatus: job.upstreamStatus,
    })
  }, 30 * 1000)

  fetch(targetUrl, {
    method,
    headers,
    body,
    signal: controller.signal,
  })
    .then(async (response) => {
      job.phase = 'response_received'
      job.upstreamStatus = response.status
      job.upstreamElapsedMs = Date.now() - now
      job.updatedAt = Date.now()
      if (pendingTimeout) clearTimeout(pendingTimeout)
      addServerLog('info', 'server:job', '上游响应头已返回', { id, status: response.status, upstreamElapsedMs: job.upstreamElapsedMs })
      const responseHeaders = {}
      response.headers.forEach((value, key) => {
        if (key === 'content-encoding' || key === 'content-length' || key === 'transfer-encoding') return
        responseHeaders[key] = value
      })
      const readResult = await readUpstreamResponseBody(response)
      const rawResponseBody = readResult.body
      if (readResult.completedBy) {
        addServerLog('info', 'server:job', '已识别完整上游响应，无需等待连接关闭', {
          id,
          completedBy: readResult.completedBy,
          responseBytes: Buffer.byteLength(rawResponseBody, 'utf8'),
        })
      }
      const inlineResult = response.ok
        ? await inlineImageUrlsInResponseBody(rawResponseBody)
        : { body: rawResponseBody, count: 0, urlCount: 0 }
      const responseBody = inlineResult.body
      if (inlineResult.count > 0) addServerLog('info', 'server:job', '图片 URL 已内联', { id, count: inlineResult.count })
      job.responseBytes = Buffer.byteLength(responseBody, 'utf8')
      job.response = {
        status: response.status,
        headers: responseHeaders,
        body: responseBody,
      }
      if (upstreamTimeout) clearTimeout(upstreamTimeout)
      if (pendingTimeout) clearTimeout(pendingTimeout)
      clearInterval(heartbeat)
      job.status = response.ok ? 'done' : 'error'
      job.phase = response.ok ? 'done' : 'error'
      job.error = response.ok ? null : responseBody || `上游接口返回 HTTP ${response.status}`
      job.updatedAt = Date.now()
      addServerLog(job.status === 'done' ? 'info' : 'error', 'server:job', '任务结束', {
        id,
        status: job.status,
        upstreamStatus: response.status,
        responseBytes: job.responseBytes,
        error: job.error,
      })
    })
    .catch((err) => {
      if (upstreamTimeout) clearTimeout(upstreamTimeout)
      if (pendingTimeout) clearTimeout(pendingTimeout)
      clearInterval(heartbeat)
      job.status = 'error'
      job.phase = 'error'
      job.upstreamElapsedMs = Date.now() - now
      const abortReason = controller.signal.reason
      job.error = abortReason instanceof Error
        ? abortReason.message
        : err instanceof Error ? err.message : String(err)
      job.updatedAt = Date.now()
      addServerLog('error', 'server:job', '任务异常', { id, error: job.error })
    })

  return job
}

function cleanupJobs() {
  const now = Date.now()
  for (const [id, job] of jobs) {
    if (job.status === 'running') continue
    if (now - job.updatedAt > jobTtlMs) jobs.delete(id)
  }
}

setInterval(cleanupJobs, Math.min(jobTtlMs, 10 * 60 * 1000)).unref()

const server = http.createServer(async (req, res) => {
  try {
    res.setHeader('access-control-allow-origin', '*')
    res.setHeader('access-control-allow-methods', 'GET,POST,DELETE,OPTIONS')
    res.setHeader('access-control-allow-headers', 'content-type')
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    if (req.method === 'GET' && req.url?.startsWith('/image-proxy?')) {
      await proxyImage(req, res)
      return
    }

    if (req.method === 'GET' && req.url?.startsWith('/api-jobs-health')) {
      sendJson(res, 200, {
        ok: true,
        version: '0.6.42',
        imageInlineTimeoutMs,
        upstreamTimeoutMs,
        pendingTimeoutMs,
        runningJobs: Array.from(jobs.values()).filter((job) => job.status === 'running').length,
      })
      return
    }

    if (req.method === 'GET' && req.url?.startsWith('/api-jobs-logs')) {
      sendJson(res, 200, {
        ok: true,
        logs: serverLogs,
      })
      return
    }

    const match = req.url?.match(/^\/api-jobs\/([^/?#]+)/)
    if (!match) {
      sendJson(res, 404, { error: 'Not found' })
      return
    }

    const id = decodeURIComponent(match[1])
    if (!/^[\w.-]{1,120}$/.test(id)) {
      sendJson(res, 400, { error: '任务 ID 无效' })
      return
    }

    if (req.method === 'GET') {
      const job = jobs.get(id)
      if (!job) {
        sendJson(res, 404, { error: '任务不存在' })
        return
      }
      sendJson(res, 200, publicJob(job))
      return
    }

    if (req.method === 'DELETE') {
      const job = jobs.get(id)
      if (job?.status === 'running') job.controller.abort()
      jobs.delete(id)
      sendJson(res, 200, { ok: true })
      return
    }

    if (req.method === 'POST') {
      const existing = jobs.get(id)
      if (existing) {
        sendJson(res, 200, publicJob(existing))
        return
      }

      const payload = JSON.parse(await readBody(req))
      const job = startJob(id, payload)
      sendJson(res, 202, publicJob(job))
      return
    }

    sendJson(res, 405, { error: 'Method not allowed' })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
})

server.listen(port, host, () => {
  console.log(`job server listening on ${host}:${port}`)
})
