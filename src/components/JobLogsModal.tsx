import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { clearJobLogs, getJobLogs, subscribeJobLogs, type JobLogEntry } from '../lib/jobLogs'
import { copyTextToClipboard } from '../lib/clipboard'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'
import { usePreventBackgroundScroll } from '../hooks/usePreventBackgroundScroll'
import { CloseIcon, CopyIcon, RefreshIcon, TrashIcon } from './icons'

interface Props {
  onClose: () => void
}

function formatLog(entry: JobLogEntry) {
  const data = entry.data === undefined ? '' : ` ${JSON.stringify(entry.data)}`
  return `[${entry.time}] [${entry.level}] [${entry.source}] ${entry.message}${data}`
}

async function fetchServerLogs(): Promise<JobLogEntry[]> {
  const response = await fetch('/api-jobs-logs', { cache: 'no-store' })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const payload = await response.json() as { logs?: JobLogEntry[] }
  return Array.isArray(payload.logs) ? payload.logs : []
}

async function fetchJobHealth() {
  const response = await fetch('/api-jobs-health', { cache: 'no-store' })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return await response.json()
}

export default function JobLogsModal({ onClose }: Props) {
  const [clientLogs, setClientLogs] = useState<JobLogEntry[]>(() => getJobLogs())
  const [serverLogs, setServerLogs] = useState<JobLogEntry[]>([])
  const [health, setHealth] = useState<unknown>(null)
  const [loadError, setLoadError] = useState('')
  const [copied, setCopied] = useState(false)

  useCloseOnEscape(true, onClose)
  usePreventBackgroundScroll(true)

  const refresh = async () => {
    setClientLogs(getJobLogs())
    setLoadError('')
    try {
      const [nextServerLogs, nextHealth] = await Promise.all([
        fetchServerLogs(),
        fetchJobHealth(),
      ])
      setServerLogs(nextServerLogs)
      setHealth(nextHealth)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err))
    }
  }

  useEffect(() => {
    void refresh()
    return subscribeJobLogs(() => setClientLogs(getJobLogs()))
  }, [])

  const text = useMemo(() => {
    const lines = [
      `页面时间：${new Date().toISOString()}`,
      `User Agent：${typeof navigator !== 'undefined' ? navigator.userAgent : ''}`,
      `URL：${typeof location !== 'undefined' ? location.href : ''}`,
      `后端健康：${JSON.stringify(health)}`,
      '',
      '===== 前端日志 =====',
      ...clientLogs.map(formatLog),
      '',
      '===== 后端代理日志 =====',
      ...serverLogs.map(formatLog),
      loadError ? `\n日志接口错误：${loadError}` : '',
    ]
    return lines.join('\n')
  }, [clientLogs, health, loadError, serverLogs])

  const copyLogs = async () => {
    await copyTextToClipboard(text)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[86vh] w-full max-w-5xl flex-col overflow-hidden rounded-3xl border border-gray-200 bg-white shadow-2xl dark:border-white/[0.08] dark:bg-gray-950">
        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-4 dark:border-white/[0.08]">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">运行日志</h2>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">复现转圈后点“复制全部日志”发给我，里面不包含 API Key 明文。</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-xl p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-white/[0.06] dark:hover:text-gray-200">
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 px-5 py-3 text-sm dark:border-white/[0.08]">
          <button type="button" onClick={() => void refresh()} className="inline-flex items-center gap-2 rounded-xl border border-gray-200 px-3 py-2 text-gray-700 hover:bg-gray-50 dark:border-white/[0.08] dark:text-gray-200 dark:hover:bg-white/[0.06]">
            <RefreshIcon className="h-4 w-4" />
            刷新
          </button>
          <button type="button" onClick={() => void copyLogs()} className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-3 py-2 text-white hover:bg-blue-700">
            <CopyIcon className="h-4 w-4" />
            {copied ? '已复制' : '复制全部日志'}
          </button>
          <button
            type="button"
            onClick={() => {
              clearJobLogs()
              setClientLogs([])
            }}
            className="inline-flex items-center gap-2 rounded-xl border border-gray-200 px-3 py-2 text-gray-700 hover:bg-gray-50 dark:border-white/[0.08] dark:text-gray-200 dark:hover:bg-white/[0.06]"
          >
            <TrashIcon className="h-4 w-4" />
            清空前端日志
          </button>
          <span className="ml-auto text-xs text-gray-500 dark:text-gray-400">前端 {clientLogs.length} 条 / 后端 {serverLogs.length} 条</span>
        </div>

        {loadError && (
          <div className="border-b border-yellow-200 bg-yellow-50 px-5 py-2 text-sm text-yellow-800 dark:border-yellow-500/30 dark:bg-yellow-500/10 dark:text-yellow-200">
            后端日志接口读取失败：{loadError}
          </div>
        )}

        <textarea
          readOnly
          value={text}
          className="min-h-[420px] flex-1 resize-none bg-gray-950 p-4 font-mono text-xs leading-5 text-gray-100 outline-none"
        />
      </div>
    </div>,
    document.body,
  )
}
