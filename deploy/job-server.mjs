import http from 'node:http'

const host = process.env.JOB_SERVER_HOST || '127.0.0.1'
const port = Number(process.env.JOB_SERVER_PORT || 8787)
const jobTtlMs = Number(process.env.JOB_TTL_MS || 2 * 60 * 60 * 1000)
const jobs = new Map()

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
  const raw = process.env.API_PROXY_URL || process.env.API_URL || 'https://api.openai.com'
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

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    response: job.response,
    error: job.error,
  }
}

function startJob(id, payload) {
  const now = Date.now()
  const controller = new AbortController()
  const job = {
    id,
    status: 'running',
    createdAt: now,
    updatedAt: now,
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

  fetch(targetUrl, {
    method,
    headers,
    body,
    signal: controller.signal,
  })
    .then(async (response) => {
      const responseHeaders = {}
      response.headers.forEach((value, key) => {
        if (key === 'content-encoding' || key === 'content-length' || key === 'transfer-encoding') return
        responseHeaders[key] = value
      })
      job.status = 'done'
      job.response = {
        status: response.status,
        headers: responseHeaders,
        body: await response.text(),
      }
      job.updatedAt = Date.now()
    })
    .catch((err) => {
      job.status = 'error'
      job.error = err instanceof Error ? err.message : String(err)
      job.updatedAt = Date.now()
    })

  return job
}

function cleanupJobs() {
  const now = Date.now()
  for (const [id, job] of jobs) {
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
