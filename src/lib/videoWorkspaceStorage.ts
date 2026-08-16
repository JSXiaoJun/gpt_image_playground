import { ensureWorkspaceConversation, getWorkspaceConversationState, syncWorkspaceConversationStats, touchWorkspaceConversation } from './workspaceConversations'

export interface VideoConversationDraft {
  prompt: string
  imageUrlText: string
  referenceVideo: string
  audioUrlText: string
}

export const VIDEO_TASKS_KEY = 'gpt-image-playground-video-tasks-v1'
export const VIDEO_DRAFTS_KEY = 'gpt-image-playground-video-drafts-v1'

export function readVideoConversationDrafts(): Record<string, VideoConversationDraft> {
  try {
    const value = JSON.parse(localStorage.getItem(VIDEO_DRAFTS_KEY) ?? 'null')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).flatMap(([id, draft]) => {
      if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return []
      const item = draft as Partial<VideoConversationDraft>
      return [[id, {
        prompt: typeof item.prompt === 'string' ? item.prompt : '',
        imageUrlText: typeof item.imageUrlText === 'string' ? item.imageUrlText : '',
        referenceVideo: typeof item.referenceVideo === 'string' ? item.referenceVideo : '',
        audioUrlText: typeof item.audioUrlText === 'string' ? item.audioUrlText : '',
      } satisfies VideoConversationDraft]]
    }))
  } catch {
    return {}
  }
}

export function writeVideoConversationDraft(id: string, draft: VideoConversationDraft) {
  const drafts: Record<string, VideoConversationDraft> = readVideoConversationDrafts()
  const empty = !draft.prompt && !draft.imageUrlText && !draft.referenceVideo && !draft.audioUrlText
  if (empty) delete drafts[id]
  else drafts[id] = draft
  localStorage.setItem(VIDEO_DRAFTS_KEY, JSON.stringify(drafts))
}

export function deleteVideoConversationData(id: string) {
  try {
    const tasks = JSON.parse(localStorage.getItem(VIDEO_TASKS_KEY) ?? '[]')
    if (Array.isArray(tasks)) localStorage.setItem(VIDEO_TASKS_KEY, JSON.stringify(tasks.filter((task) => !task || typeof task !== 'object' || task.workspaceConversationId !== id)))
  } catch {
    localStorage.removeItem(VIDEO_TASKS_KEY)
  }
  const drafts: Record<string, VideoConversationDraft> = readVideoConversationDrafts()
  delete drafts[id]
  localStorage.setItem(VIDEO_DRAFTS_KEY, JSON.stringify(drafts))
}

export function clearVideoWorkspaceData() {
  localStorage.removeItem(VIDEO_TASKS_KEY)
  localStorage.removeItem(VIDEO_DRAFTS_KEY)
}

export function migrateStoredVideoConversations() {
  try {
    const value = JSON.parse(localStorage.getItem(VIDEO_TASKS_KEY) ?? '[]')
    if (!Array.isArray(value) || !value.length) return
    const fallbackId = ensureWorkspaceConversation('video', '历史视频')
    const validIds = new Set(getWorkspaceConversationState().conversations.filter((item) => item.kind === 'video').map((item) => item.id))
    const tasks = value.map((task) => {
      if (!task || typeof task !== 'object') return task
      return typeof task.workspaceConversationId === 'string' && validIds.has(task.workspaceConversationId)
        ? task
        : { ...task, workspaceConversationId: fallbackId }
    })
    localStorage.setItem(VIDEO_TASKS_KEY, JSON.stringify(tasks))
    const stats: Record<string, { taskCount: number; updatedAt: number }> = {}
    for (const task of tasks) {
      if (!task || typeof task !== 'object' || typeof task.workspaceConversationId !== 'string') continue
      const current = stats[task.workspaceConversationId]
      const updatedAt = typeof task.updatedAt === 'number' ? task.updatedAt : typeof task.createdAt === 'number' ? task.createdAt : 0
      stats[task.workspaceConversationId] = { taskCount: (current?.taskCount ?? 0) + 1, updatedAt: Math.max(current?.updatedAt ?? 0, updatedAt) }
    }
    syncWorkspaceConversationStats('video', stats)
    const latest = tasks.filter((task) => task && typeof task === 'object' && task.workspaceConversationId === fallbackId).sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0))[0]
    if (latest && typeof latest.prompt === 'string') touchWorkspaceConversation(fallbackId, latest.prompt)
  } catch (err) {
    console.warn('Failed to migrate video conversations:', err)
  }
}
