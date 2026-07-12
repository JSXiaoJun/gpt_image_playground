import { isApiProxyAvailable, readClientDevProxyConfig } from './devProxy'
import { addJobLog } from './jobLogs'
import { readRuntimeEnv } from './runtimeEnv'

export interface PersistentProxyJobResponse {
  id: string
  status: 'running' | 'done' | 'error'
  phase?: 'pending' | 'response_received' | 'done' | 'error'
  upstreamStatus?: number | null
  upstreamElapsedMs?: number | null
  responseBytes?: number | null
  response?: {
    status: number
    headers: Record<string, string>
    body: string
  } | null
  error?: string | null
}

const JOB_POLL_INTERVAL_MS = 1000
const JOB_EXISTENCE_CHECK_TIMEOUT_MS = 5000

function isDockerDeployment() {
  return readRuntimeEnv(import.meta.env.VITE_DOCKER_DEPLOYMENT) === 'true'
}

function canReachPersistentProxyJobServer() {
  return isDockerDeployment() || import.meta.env.DEV
}

function getPersistentProxyUrl(url: string) {
  if (url.startsWith('/api-proxy/')) return url
  if (!isApiProxyAvailable()) return null

  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
    if (!/^\/v\d+(?:beta)?\//.test(parsed.pathname)) return null
    const prefix = readClientDevProxyConfig()?.prefix ?? '/api-proxy'
    return `${prefix}${parsed.pathname}${parsed.search}`
  } catch {
    return null
  }
}

function canUsePersistentProxyJob(url: string, init: RequestInit, jobId?: string) {
  const method = (init.method ?? 'GET').toUpperCase()
  return Boolean(
    jobId &&
    canReachPersistentProxyJobServer() &&
    isApiProxyAvailable() &&
    method === 'POST' &&
    getPersistentProxyUrl(url) &&
    (typeof init.body === 'string' || init.body == null),
  )
}

function headersToRecord(headers: HeadersInit | undefined) {
  const output: Record<string, string> = {}
  if (!headers) return output

  new Headers(headers).forEach((value, key) => {
    output[key] = value
  })
  return output
}

function wait(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }

    const timer = window.setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      window.clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }, { once: true })
  })
}

export async function readPersistentProxyJob(jobId: string, signal?: AbortSignal, summaryOnly = false) {
  const query = summaryOnly ? '?summary=1' : ''
  const response = await fetch(`/api-jobs/${encodeURIComponent(jobId)}${query}`, { cache: 'no-store', signal })
  if (!response.ok) {
    addJobLog('warn', 'frontend:job-read', '任务代理记录读取失败', { jobId, status: response.status })
    return null
  }
  const job = await response.json() as PersistentProxyJobResponse
  addJobLog('debug', 'frontend:job-read', '任务代理状态', {
    jobId,
    status: job.status,
    phase: job.phase,
    upstreamStatus: job.upstreamStatus,
    upstreamElapsedMs: job.upstreamElapsedMs,
    responseBytes: job.responseBytes,
    hasResponse: Boolean(job.response),
    error: job.error,
  })
  return job
}

async function pollJob(jobId: string, signal?: AbortSignal): Promise<Response> {
  while (true) {
    const job = await readPersistentProxyJob(jobId)
    if (!job) throw new Error('任务代理记录不存在')

    if (job.status === 'done') {
      const response = job.response
      if (!response) throw new Error('任务代理没有返回响应')
      addJobLog('info', 'frontend:job-poll', '任务代理完成', {
        jobId,
        status: response.status,
        upstreamStatus: job.upstreamStatus,
        upstreamElapsedMs: job.upstreamElapsedMs,
        responseBytes: job.responseBytes,
      })
      return new Response(response.body, {
        status: response.status,
        headers: response.headers,
      })
    }

    if (job.status === 'error') {
      addJobLog('error', 'frontend:job-poll', '任务代理失败', { jobId, error: job.error })
      throw new Error(job.error || '任务代理请求失败')
    }

    await wait(JOB_POLL_INTERVAL_MS, signal)
  }
}

export async function fetchWithPersistentProxy(url: string, init: RequestInit, jobId?: string, timeoutSeconds?: number) {
  if (!canUsePersistentProxyJob(url, init, jobId)) return fetch(url, init)
  const persistentProxyUrl = getPersistentProxyUrl(url)
  if (!persistentProxyUrl) return fetch(url, init)

  const jobPayload = JSON.stringify({
    url: persistentProxyUrl,
    method: init.method ?? 'POST',
    headers: headersToRecord(init.headers),
    body: typeof init.body === 'string' ? init.body : '',
    timeoutMs: typeof timeoutSeconds === 'number' && Number.isFinite(timeoutSeconds)
      ? Math.max(30_000, timeoutSeconds * 1000)
      : undefined,
  })
  addJobLog('info', 'frontend:job-start', '提交任务代理', {
    jobId,
    url: persistentProxyUrl,
    method: init.method ?? 'POST',
    bodyLength: typeof init.body === 'string' ? init.body.length : 0,
    timeoutSeconds,
  })
  const response = await fetch(`/api-jobs/${encodeURIComponent(jobId!)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: jobPayload,
    keepalive: jobPayload.length <= 60_000,
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    addJobLog('error', 'frontend:job-start', '任务代理启动失败', { jobId, status: response.status, body: text })
    throw new Error(text || `任务代理启动失败：${response.status}`)
  }
  addJobLog('info', 'frontend:job-start', '任务代理已启动', { jobId, status: response.status })

  // 持久化任务由后端 job-server 接管，前端的请求超时只应该中断普通直连请求。
  // 这里不能传 init.signal，否则超过接口配置的 timeout 后会把仍在后台运行的任务误标失败。
  return pollJob(jobId!)
}

export async function hasPersistentProxyJob(jobId: string) {
  if (!canReachPersistentProxyJobServer() || !isApiProxyAvailable()) return false
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), JOB_EXISTENCE_CHECK_TIMEOUT_MS)
  try {
    return Boolean(await readPersistentProxyJob(jobId, controller.signal, true).catch(() => null))
  } finally {
    window.clearTimeout(timer)
  }
}
