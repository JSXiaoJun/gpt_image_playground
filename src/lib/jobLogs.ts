export type JobLogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface JobLogEntry {
  id: string
  time: string
  level: JobLogLevel
  source: string
  message: string
  data?: unknown
}

const STORAGE_KEY = 'gpt-image-playground.job-logs'
const MAX_LOGS = 1000
const EVENT_NAME = 'gpt-image-playground-job-logs'

function readStoredLogs(): JobLogEntry[] {
  if (typeof window === 'undefined') return []

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((item): item is JobLogEntry => Boolean(item?.id && item?.time && item?.message)) : []
  } catch {
    return []
  }
}

function writeStoredLogs(logs: JobLogEntry[]) {
  if (typeof window === 'undefined') return

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(logs.slice(-MAX_LOGS)))
    window.dispatchEvent(new Event(EVENT_NAME))
  } catch {
    /* ignore */
  }
}

export function sanitizeJobLogData(value: unknown): unknown {
  if (value == null) return value
  if (typeof value === 'string') {
    if (/^sk-[A-Za-z0-9_-]{8,}/.test(value)) return `${value.slice(0, 6)}***`
    if (value.length > 2000) return `${value.slice(0, 2000)}...<${value.length} chars>`
    return value
  }
  if (typeof value !== 'object') return value
  if (Array.isArray(value)) return value.slice(0, 20).map(sanitizeJobLogData)

  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (/authorization|api[-_]?key|token|secret|password/i.test(key)) {
      output[key] = '***'
      continue
    }
    output[key] = sanitizeJobLogData(item)
  }
  return output
}

export function addJobLog(level: JobLogLevel, source: string, message: string, data?: unknown) {
  const entry: JobLogEntry = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    time: new Date().toISOString(),
    level,
    source,
    message,
    data: sanitizeJobLogData(data),
  }
  writeStoredLogs([...readStoredLogs(), entry])
}

export function getJobLogs() {
  return readStoredLogs()
}

export function clearJobLogs() {
  writeStoredLogs([])
}

export function subscribeJobLogs(callback: () => void) {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener(EVENT_NAME, callback)
  return () => window.removeEventListener(EVENT_NAME, callback)
}
