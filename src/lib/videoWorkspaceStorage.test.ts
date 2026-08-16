import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getWorkspaceConversationState, resetWorkspaceConversationsForTests } from './workspaceConversations'
import { clearVideoWorkspaceData, migrateStoredVideoConversations, readVideoConversationDrafts, VIDEO_TASKS_KEY, writeVideoConversationDraft } from './videoWorkspaceStorage'

let values: Map<string, string>

beforeEach(() => {
  values = new Map()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  })
  resetWorkspaceConversationsForTests({ conversations: [], activeIds: { image: null, video: null }, sidebarCollapsed: false })
})

afterEach(() => vi.unstubAllGlobals())

describe('videoWorkspaceStorage', () => {
  it('moves legacy video tasks into one conversation', () => {
    localStorage.setItem(VIDEO_TASKS_KEY, JSON.stringify([
      { id: 'old-1', prompt: '早期视频', createdAt: 10, updatedAt: 20 },
      { id: 'old-2', prompt: '最近的视频提示词', createdAt: 30, updatedAt: 40 },
    ]))

    migrateStoredVideoConversations()

    const state = getWorkspaceConversationState()
    const conversation = state.conversations[0]
    const tasks = JSON.parse(localStorage.getItem(VIDEO_TASKS_KEY) ?? '[]')
    expect(conversation).toMatchObject({ kind: 'video', title: '历史视频', taskCount: 2 })
    expect(tasks.every((task: { workspaceConversationId?: string }) => task.workspaceConversationId === conversation.id)).toBe(true)
  })

  it('stores drafts independently by conversation', () => {
    writeVideoConversationDraft('video-a', { prompt: 'A', imageUrlText: '', referenceVideo: '', audioUrlText: '' })
    writeVideoConversationDraft('video-b', { prompt: 'B', imageUrlText: 'https://example.com/a.png', referenceVideo: '', audioUrlText: '' })

    expect(readVideoConversationDrafts()).toEqual({
      'video-a': { prompt: 'A', imageUrlText: '', referenceVideo: '', audioUrlText: '' },
      'video-b': { prompt: 'B', imageUrlText: 'https://example.com/a.png', referenceVideo: '', audioUrlText: '' },
    })
  })

  it('clears stored tasks and drafts', () => {
    localStorage.setItem(VIDEO_TASKS_KEY, JSON.stringify([{ id: 'video-a' }]))
    writeVideoConversationDraft('video-a', { prompt: '草稿', imageUrlText: '', referenceVideo: '', audioUrlText: '' })

    clearVideoWorkspaceData()

    expect(localStorage.getItem(VIDEO_TASKS_KEY)).toBeNull()
    expect(readVideoConversationDrafts()).toEqual({})
  })
})
