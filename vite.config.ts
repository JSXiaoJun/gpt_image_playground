import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'fs'
import { normalizeDevProxyConfig } from './src/lib/devProxy'
import { extractJobImages, getJobImageUrls } from './deploy/job-images.mjs'
import { readUpstreamResponseBody } from './deploy/read-upstream-body.mjs'

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'))
const JOB_PENDING_TIMEOUT_MS = 180_000
const devJobLogs: Array<{ id: string; time: string; level: string; source: string; message: string; data?: unknown }> = []

function addDevJobLog(level: string, source: string, message: string, data?: unknown) {
  devJobLogs.push({
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    time: new Date().toISOString(),
    level,
    source,
    message,
    data,
  })
  while (devJobLogs.length > 1000) devJobLogs.shift()
}

const DEFAULT_DEV_PROXY_CONFIG = {
  enabled: true,
  locked: true,
  prefix: '/api-proxy',
  target: 'https://zl.yyapi.cloud',
  changeOrigin: true,
  secure: true,
}

function loadDevProxyConfig() {
  try {
    return normalizeDevProxyConfig(
      JSON.parse(readFileSync('./dev-proxy.config.json', 'utf-8')) as unknown,
    )
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err.code === 'ENOENT') return normalizeDevProxyConfig(DEFAULT_DEV_PROXY_CONFIG)
    throw error
  }
}

function readRequestBuffer(req: NodeJS.ReadableStream) {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readRequestBody(req: NodeJS.ReadableStream) {
  return (await readRequestBuffer(req)).toString('utf8')
}

async function proxyDevImage(req: any, res: any) {
  const requestUrl = new URL(req.url || '', 'http://127.0.0.1')
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
    res.statusCode = response.status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ error: `图片加载失败：HTTP ${response.status}` }))
    return
  }

  const contentType = response.headers.get('content-type') || 'application/octet-stream'
  if (!contentType.toLowerCase().startsWith('image/')) throw new Error('目标链接不是图片响应')

  const body = Buffer.from(await response.arrayBuffer())
  res.statusCode = 200
  res.setHeader('content-type', contentType)
  res.setHeader('cache-control', 'public, max-age=86400')
  res.setHeader('content-length', String(body.length))
  res.end(body)
}

function isHttpUrl(value: unknown) {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function createDevJobMiddleware(devProxyConfig: ReturnType<typeof loadDevProxyConfig>) {
  type JobImage = { base64?: string; mimeType?: string; url?: string; body?: Buffer; loading?: Promise<JobImage> }
  const jobs = new Map<string, {
    id: string
    status: 'running' | 'done' | 'error'
    phase: 'pending' | 'response_received' | 'done' | 'error'
    createdAt: number
    updatedAt: number
    response: { status: number; headers: Record<string, string>; body: string } | null
    error: string | null
    upstreamStatus?: number | null
    upstreamElapsedMs?: number | null
    responseBytes?: number | null
    images?: JobImage[]
  }>()

  const loadJobImage = async (image: JobImage): Promise<JobImage> => {
    if (image.body) return image
    if (image.loading) return image.loading

    image.loading = (async () => {
      if (image.base64) {
        image.body = Buffer.from(image.base64, 'base64')
        delete image.base64
        return image
      }
      if (!isHttpUrl(image.url)) throw new Error('Invalid image URL')
      const response = await fetch(image.url, {
        headers: {
          accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
          'user-agent': 'gpt-image-playground-image-proxy/1.0',
        },
      })
      if (!response.ok) throw new Error(`Image fetch failed: HTTP ${response.status}`)
      const contentType = response.headers.get('content-type') || ''
      if (!contentType.toLowerCase().startsWith('image/')) throw new Error('Target URL did not return an image')
      image.mimeType = contentType.split(';')[0]
      image.body = Buffer.from(await response.arrayBuffer())
      return image
    })()

    try {
      return await image.loading
    } finally {
      delete image.loading
    }
  }

  const sendJson = (res: any, status: number, data: unknown) => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(data))
  }

  const buildTargetUrl = (proxiedUrl: string) => {
    if (!devProxyConfig) throw new Error('开发代理未启用')
    if (!proxiedUrl.startsWith(`${devProxyConfig.prefix}/`)) throw new Error('仅支持开发代理路径')
    const path = proxiedUrl.replace(new RegExp(`^${devProxyConfig.prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\/+`), '')
    if (!path || path.includes('..') || path.startsWith('/')) throw new Error('代理路径无效')
    const target = devProxyConfig.target.replace(/\/+$/, '')
    return `${target}/${path}`
  }

  const startJob = (id: string, payload: any) => {
    const startedAt = Date.now()
    const controller = new AbortController()
    const job = {
      id,
      status: 'running' as const,
      phase: 'pending' as const,
      createdAt: startedAt,
      updatedAt: startedAt,
      response: null,
      error: null,
      upstreamStatus: null,
      upstreamElapsedMs: null,
      responseBytes: null,
      images: [],
    }
    jobs.set(id, job)

    const method = String(payload.method || 'POST').toUpperCase()
    const body = method === 'GET' || method === 'HEAD'
      ? undefined
      : Buffer.isBuffer(payload.bodyBuffer)
        ? payload.bodyBuffer
        : typeof payload.body === 'string' ? payload.body : undefined
    let requestSummary: Record<string, unknown> = {}
    try {
      const parsedBody = typeof body === 'string' ? JSON.parse(body) : {}
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
    if (Buffer.isBuffer(body)) requestSummary = { bodyLength: body.length, multipart: true }
    const payloadTimeoutMs = Number(payload.timeoutMs)
    const timeoutMs = Number.isFinite(payloadTimeoutMs) && payloadTimeoutMs > 0 ? Math.max(30_000, payloadTimeoutMs) : 0
    const timeout = timeoutMs > 0
      ? setTimeout(() => controller.abort(new Error(`上游请求超过 ${Math.round(timeoutMs / 1000)} 秒仍未返回`)), timeoutMs)
      : null
    const pendingTimeout = setTimeout(() => {
      controller.abort(new Error(`上游请求已提交，但 ${Math.round(JOB_PENDING_TIMEOUT_MS / 1000)} 秒内没有返回 HTTP 响应头。NewAPI 后台可能已生成/扣费，但当前 HTTP 连接没有把结果返回给本服务。任务 ID：${id}`))
    }, JOB_PENDING_TIMEOUT_MS)
    const heartbeat = setInterval(() => {
      if (job.status !== 'running') return
      addDevJobLog('debug', 'dev:job', '任务仍在等待上游响应', {
        id,
        elapsedMs: Date.now() - startedAt,
        upstreamStatus: job.upstreamStatus,
      })
    }, 30_000)
    addDevJobLog('info', 'dev:job', '任务开始', { id, method, timeoutMs, pendingTimeoutMs: JOB_PENDING_TIMEOUT_MS, request: requestSummary })
    fetch(buildTargetUrl(String(payload.url || '')), {
      method,
      headers: payload.headers || {},
      body,
      signal: controller.signal,
    })
      .then(async (response) => {
        clearTimeout(pendingTimeout)
        job.phase = 'response_received'
        const headers: Record<string, string> = {}
        response.headers.forEach((value, key) => {
          if (key === 'content-encoding' || key === 'content-length' || key === 'transfer-encoding') return
          headers[key] = value
        })
        const readResult = await readUpstreamResponseBody(response)
        const rawBody = readResult.body
        if (readResult.completedBy) {
          addDevJobLog('info', 'dev:job', '已识别完整上游响应，无需等待连接关闭', {
            id,
            completedBy: readResult.completedBy,
            responseBytes: Buffer.byteLength(rawBody, 'utf8'),
          })
        }
        const body = rawBody
        job.status = response.ok ? 'done' : 'error'
        job.phase = response.ok ? 'done' : 'error'
        job.upstreamStatus = response.status
        job.upstreamElapsedMs = Date.now() - startedAt
        job.responseBytes = Buffer.byteLength(body, 'utf8')
        job.images = response.ok ? extractJobImages(body) as JobImage[] : []
        job.response = { status: response.status, headers, body: job.images.length > 0 ? '' : body }
        job.error = response.ok ? null : body || `上游接口返回 HTTP ${response.status}`
        job.updatedAt = Date.now()
        for (const image of job.images) {
          void loadJobImage(image).catch((error) => {
            addDevJobLog('warn', 'dev:image-cache', '图片二进制缓存失败', {
              id,
              error: error instanceof Error ? error.message : String(error),
            })
          })
        }
        addDevJobLog(response.ok ? 'info' : 'error', 'dev:job', '任务结束', {
          id,
          status: job.status,
          upstreamStatus: response.status,
          upstreamElapsedMs: job.upstreamElapsedMs,
          error: job.error,
        })
      })
      .catch((error) => {
        job.status = 'error'
        job.phase = 'error'
        job.error = error instanceof Error ? error.message : String(error)
        job.updatedAt = Date.now()
        addDevJobLog('error', 'dev:job', '任务异常', { id, error: job.error })
      })
      .finally(() => {
        if (timeout) clearTimeout(timeout)
        clearTimeout(pendingTimeout)
        clearInterval(heartbeat)
      })

    return job
  }

  return async (req: any, res: any, next: () => void) => {
    if (req.url?.startsWith('/api-jobs-health')) {
      sendJson(res, 200, {
        ok: true,
        version: '0.6.50',
        pendingTimeoutMs: JOB_PENDING_TIMEOUT_MS,
        runningJobs: Array.from(jobs.values()).filter((job) => job.status === 'running').length,
      })
      return
    }

    if (req.url?.startsWith('/api-jobs-logs')) {
      sendJson(res, 200, { ok: true, logs: devJobLogs })
      return
    }

    if (!req.url?.startsWith('/api-jobs/')) {
      next()
      return
    }

    const id = decodeURIComponent(req.url.replace(/^\/api-jobs\/([^/?#]+).*$/, '$1'))
    if (!/^[\w.-]{1,120}$/.test(id)) {
      sendJson(res, 400, { error: '任务 ID 无效' })
      return
    }

    if (req.method === 'GET') {
      const job = jobs.get(id)
      if (job) {
        const imageMatch = req.url?.match(/^\/api-jobs\/[^/?#]+\/images\/(\d+)/)
        if (imageMatch) {
          const image = job.images?.[Number(imageMatch[1])]
          if (!image) {
            sendJson(res, job.status === 'running' ? 202 : 404, { status: job.status, error: job.status === 'running' ? '图片仍在生成或传输中' : '图片不存在' })
            return
          }
          const loaded = await loadJobImage(image)
          const body = loaded.body || Buffer.alloc(0)
          res.statusCode = 200
          res.setHeader('content-type', loaded.mimeType || 'image/png')
          res.setHeader('content-length', String(body.length))
          res.setHeader('cache-control', 'private, max-age=7200')
          res.end(body)
          return
        }
        if (req.url?.match(/^\/api-jobs\/[^/?#]+\/result(?:[?#]|$)/)) {
          const imageUrls = getJobImageUrls(job)
          const content = job.status === 'done'
            ? imageUrls.map((url, index) => `<figure><img src="${url}" alt="结果 ${index + 1}"><figcaption><a href="${url}" target="_blank">打开原图 ${index + 1}</a></figcaption></figure>`).join('') || '<p>任务已完成，但没有可识别的图片。</p>'
            : `<p>${job.phase === 'response_received' ? '上游已返回，正在接收图片数据...' : '图片正在生成...'}</p>`
          const refresh = job.status === 'running' ? '<meta http-equiv="refresh" content="2">' : ''
          res.statusCode = 200
          res.setHeader('content-type', 'text/html; charset=utf-8')
          res.setHeader('cache-control', 'no-store')
          res.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">${refresh}<meta name="viewport" content="width=device-width,initial-scale=1"><title>图片任务结果</title><style>body{margin:0;padding:24px;font:14px system-ui;color:#202124;background:#f7f7f8}main{max-width:1200px;margin:auto}p{text-align:center;margin:20vh 0;color:#666}figure{margin:0 0 24px}img{display:block;max-width:100%;height:auto;margin:auto;background:#eee}figcaption{text-align:center;padding:12px}a{color:#1677ff}</style></head><body><main>${content}</main></body></html>`)
          return
        }
      }
      const summaryOnly = new URL(req.url || '', 'http://127.0.0.1').searchParams.get('summary') === '1'
      sendJson(res, job ? 200 : 404, job ? {
        ...job,
        images: undefined,
        response: summaryOnly ? null : job.response,
        resultUrl: `/api-jobs/${encodeURIComponent(job.id)}/result`,
        imageUrls: getJobImageUrls(job),
      } : { error: '任务不存在' })
      return
    }

    if (req.method === 'POST') {
      const existing = jobs.get(id)
      if (existing) {
        sendJson(res, 200, { ...existing, images: undefined })
        return
      }
      const requestUrl = new URL(req.url || '', 'http://127.0.0.1')
      const rawBody = requestUrl.searchParams.get('raw') === '1'
      const payload = rawBody
        ? {
            url: requestUrl.searchParams.get('url') || '',
            method: requestUrl.searchParams.get('method') || 'POST',
            timeoutMs: requestUrl.searchParams.get('timeoutMs'),
            headers: {
              ...JSON.parse(decodeURIComponent(String(req.headers['x-job-forward-headers'] || '%7B%7D'))),
              ...(typeof req.headers['content-type'] === 'string' ? { 'content-type': req.headers['content-type'] } : {}),
            },
            bodyBuffer: await readRequestBuffer(req),
          }
        : JSON.parse(await readRequestBody(req))
      sendJson(res, 202, startJob(id, payload))
      return
    }

    sendJson(res, 405, { error: 'Method not allowed' })
  }
}

export default defineConfig(({ command }) => {
  const devProxyConfig = command === 'serve' && process.env.VITEST !== 'true' ? loadDevProxyConfig() : null

  return {
    plugins: [
      react(),
      {
        name: 'persistent-proxy-jobs',
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            if (!req.url?.startsWith('/image-proxy?')) {
              next()
              return
            }
            try {
              await proxyDevImage(req, res)
            } catch (error) {
              res.statusCode = 500
              res.setHeader('content-type', 'application/json; charset=utf-8')
              res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
            }
          })
          if (!devProxyConfig?.enabled) return
          server.middlewares.use(createDevJobMiddleware(devProxyConfig))
        },
      },
    ],
    base: './',
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      __DEV_PROXY_CONFIG__: JSON.stringify(devProxyConfig),
    },
    server: {
      host: true,
      proxy:
        devProxyConfig?.enabled
          ? {
              [devProxyConfig.prefix]: {
                target: devProxyConfig.target,
                changeOrigin: devProxyConfig.changeOrigin,
                secure: devProxyConfig.secure,
                rewrite: (path) =>
                  path.replace(
                    new RegExp(`^${devProxyConfig.prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
                    '',
                  ),
              },
            }
          : undefined,
    },
  }
})
