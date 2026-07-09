import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'fs'
import { normalizeDevProxyConfig } from './src/lib/devProxy'

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'))

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

function readRequestBody(req: NodeJS.ReadableStream) {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
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
    fetch(buildTargetUrl(String(payload.url || '')), {
      method,
      headers: payload.headers || {},
      body: method === 'GET' || method === 'HEAD'
        ? undefined
        : typeof payload.body === 'string' ? payload.body : undefined,
    })
      .then(async (response) => {
        const headers: Record<string, string> = {}
        response.headers.forEach((value, key) => {
          if (key === 'content-encoding' || key === 'content-length' || key === 'transfer-encoding') return
          headers[key] = value
        })
        const body = await response.text()
        job.status = response.ok ? 'done' : 'error'
        job.upstreamStatus = response.status
        job.upstreamElapsedMs = Date.now() - startedAt
        job.response = { status: response.status, headers, body }
        job.error = response.ok ? null : body || `上游接口返回 HTTP ${response.status}`
        job.updatedAt = Date.now()
      })
      .catch((error) => {
        job.status = 'error'
        job.error = error instanceof Error ? error.message : String(error)
        job.updatedAt = Date.now()
      })

    return job
  }

  return async (req: any, res: any, next: () => void) => {
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
