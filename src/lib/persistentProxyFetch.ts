import { isApiProxyAvailable } from './devProxy'
import { readRuntimeEnv } from './runtimeEnv'

interface JobResponse {
  id: string
  status: 'running' | 'done' | 'error'
  response?: {
    status: number
    headers: Record<string, string>
    body: string
  } | null
  error?: string | null
}

const JOB_POLL_INTERVAL_MS = 1000

function isDockerDeployment() {
  return readRuntimeEnv(import.meta.env.VITE_DOCKER_DEPLOYMENT) === 'true'
}

function canReachPersistentProxyJobServer() {
  return isDockerDeployment() || import.meta.env.DEV
}

function canUsePersistentProxyJob(url: string, init: RequestInit, jobId?: string) {
  const method = (init.method ?? 'GET').toUpperCase()
  return Boolean(
    jobId &&
    canReachPersistentProxyJobServer() &&
    isApiProxyAvailable() &&
    method === 'POST' &&
    url.startsWith('/api-proxy/') &&
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

async function readJob(jobId: string) {
  const response = await fetch(`/api-jobs/${encodeURIComponent(jobId)}`, { cache: 'no-store' })
  if (!response.ok) return null
  return await response.json() as JobResponse
}

async function pollJob(jobId: string, signal?: AbortSignal): Promise<Response> {
  while (true) {
    const job = await readJob(jobId)
    if (!job) throw new Error('任务代理记录不存在')

    if (job.status === 'done') {
      const response = job.response
      if (!response) throw new Error('任务代理没有返回响应')
      return new Response(response.body, {
        status: response.status,
        headers: response.headers,
      })
    }

    if (job.status === 'error') {
      throw new Error(job.error || '任务代理请求失败')
    }

    await wait(JOB_POLL_INTERVAL_MS, signal)
  }
}

export async function fetchWithPersistentProxy(url: string, init: RequestInit, jobId?: string) {
  if (!canUsePersistentProxyJob(url, init, jobId)) return fetch(url, init)

  const jobPayload = JSON.stringify({
    url,
    method: init.method ?? 'POST',
    headers: headersToRecord(init.headers),
    body: typeof init.body === 'string' ? init.body : '',
  })
  const response = await fetch(`/api-jobs/${encodeURIComponent(jobId!)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: jobPayload,
    keepalive: jobPayload.length <= 60_000,
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(text || `任务代理启动失败：${response.status}`)
  }

  return pollJob(jobId!, init.signal ?? undefined)
}

export async function hasPersistentProxyJob(jobId: string) {
  if (!canReachPersistentProxyJobServer() || !isApiProxyAvailable()) return false
  return Boolean(await readJob(jobId).catch(() => null))
}
