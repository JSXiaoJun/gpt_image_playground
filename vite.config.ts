import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'fs'
import { normalizeDevProxyConfig } from './src/lib/devProxy'

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'))
const IMAGE_INLINE_TIMEOUT_MS = 8_000
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
  target: 'https://www.yyapi.cloud',
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

function readRequestBody(req: NodeJS.ReadableStream) {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
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

async function inlineImageUrlsInResponseBody(body: string) {
  let payload: any
  try {
    payload = JSON.parse(body)
  } catch {
    return { body, count: 0, urlCount: 0 }
  }

  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.data)) {
    return { body, count: 0, urlCount: 0 }
  }

  let count = 0
  const urlItems = payload.data.filter((item: any) => item && typeof item === 'object' && !item.b64_json && isHttpUrl(item.url))
  await Promise.all(payload.data.map(async (item: any) => {
    if (!item || typeof item !== 'object' || item.b64_json || !isHttpUrl(item.url)) return
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('image url inline timeout')), IMAGE_INLINE_TIMEOUT_MS)
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
    } catch (error) {
      addDevJobLog('warn', 'dev:inline-url', '图片 URL 内联失败', { error: error instanceof Error ? error.message : String(error), url: item.url })
    } finally {
      clearTimeout(timer)
    }
  }))

  return { body: count > 0 ? JSON.stringify(payload) : body, count, urlCount: urlItems.length }
}

function createDevJobMiddleware(devProxyConfig: ReturnType<typeof loadDevProxyConfig>) {
  const jobs = new Map<string, {
    id: string
    status: 'running' | 'done' | 'error'
    createdAt: number
    updatedAt: number
    response: { status: number; headers: Record<string, string>; body: string } | null
    error: string | null
    upstreamStatus?: number | null
    upstreamElapsedMs?: number | null
  }>()

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
      createdAt: startedAt,
      updatedAt: startedAt,
      response: null,
      error: null,
      upstreamStatus: null,
      upstreamElapsedMs: null,
    }
    jobs.set(id, job)

    const method = String(payload.method || 'POST').toUpperCase()
    const payloadTimeoutMs = Number(payload.timeoutMs)
    const timeoutMs = Number.isFinite(payloadTimeoutMs) && payloadTimeoutMs > 0 ? Math.max(30_000, payloadTimeoutMs) : 0
    const timeout = timeoutMs > 0
      ? setTimeout(() => controller.abort(new Error(`上游请求超过 ${Math.round(timeoutMs / 1000)} 秒仍未返回`)), timeoutMs)
      : null
    addDevJobLog('info', 'dev:job', '任务开始', { id, method, timeoutMs })
    fetch(buildTargetUrl(String(payload.url || '')), {
      method,
      headers: payload.headers || {},
      body: method === 'GET' || method === 'HEAD'
        ? undefined
        : typeof payload.body === 'string' ? payload.body : undefined,
      signal: controller.signal,
    })
      .then(async (response) => {
        const headers: Record<string, string> = {}
        response.headers.forEach((value, key) => {
          if (key === 'content-encoding' || key === 'content-length' || key === 'transfer-encoding') return
          headers[key] = value
        })
        const rawBody = await response.text()
        const inlineResult = response.ok
          ? await inlineImageUrlsInResponseBody(rawBody)
          : { body: rawBody, count: 0, urlCount: 0 }
        const body = inlineResult.body
        if (inlineResult.count > 0) addDevJobLog('info', 'dev:job', '图片 URL 已内联', { id, count: inlineResult.count })
        job.status = response.ok ? 'done' : 'error'
        job.upstreamStatus = response.status
        job.upstreamElapsedMs = Date.now() - startedAt
        job.response = { status: response.status, headers, body }
        job.error = response.ok ? null : body || `上游接口返回 HTTP ${response.status}`
        job.updatedAt = Date.now()
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
        job.error = error instanceof Error ? error.message : String(error)
        job.updatedAt = Date.now()
        addDevJobLog('error', 'dev:job', '任务异常', { id, error: job.error })
      })
      .finally(() => {
        if (timeout) clearTimeout(timeout)
      })

    return job
  }

  return async (req: any, res: any, next: () => void) => {
    if (req.url?.startsWith('/api-jobs-health')) {
      sendJson(res, 200, {
        ok: true,
        version: '0.6.40',
        imageInlineTimeoutMs: IMAGE_INLINE_TIMEOUT_MS,
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
      sendJson(res, job ? 200 : 404, job ?? { error: '任务不存在' })
      return
    }

    if (req.method === 'POST') {
      const existing = jobs.get(id)
      if (existing) {
        sendJson(res, 200, existing)
        return
      }
      const payload = JSON.parse(await readRequestBody(req))
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
