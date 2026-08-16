import { beforeEach, describe, expect, it } from 'vitest'
import { clearWorkspaceConversations, createWorkspaceConversation, createWorkspaceConversationTitle, deleteWorkspaceConversation, getWorkspaceConversationState, renameWorkspaceConversation, resetWorkspaceConversationsForTests, selectWorkspaceConversation, syncWorkspaceConversationStats, touchWorkspaceConversation } from './workspaceConversations'

beforeEach(() => {
  resetWorkspaceConversationsForTests({
    conversations: [],
    activeIds: { image: null, video: null },
    sidebarCollapsed: false,
  })
})

describe('workspaceConversations', () => {
  it('keeps independent active conversations for image and video workspaces', () => {
    const imageId = createWorkspaceConversation('image')
    const videoId = createWorkspaceConversation('video')

    expect(getWorkspaceConversationState().activeIds).toEqual({ image: imageId, video: videoId })
    expect(selectWorkspaceConversation(imageId)?.kind).toBe('image')
  })

  it('generates the title from the first prompt and preserves later titles', () => {
    const id = createWorkspaceConversation('image')

    touchWorkspaceConversation(id, '  一只猫在窗边看雨  ')
    touchWorkspaceConversation(id, '第二条提示词')

    expect(getWorkspaceConversationState().conversations[0]).toMatchObject({
      id,
      title: '一只猫在窗边看雨',
      untitled: false,
    })
  })

  it('supports rename, stats and active conversation fallback after deletion', () => {
    const firstId = createWorkspaceConversation('image')
    const secondId = createWorkspaceConversation('image')
    renameWorkspaceConversation(firstId, '产品主图')
    syncWorkspaceConversationStats('image', {
      [firstId]: { taskCount: 3, updatedAt: Date.now() + 10 },
    })

    deleteWorkspaceConversation(secondId)

    const state = getWorkspaceConversationState()
    expect(state.activeIds.image).toBe(firstId)
    expect(state.conversations[0]).toMatchObject({ title: '产品主图', taskCount: 3 })
  })

  it('truncates long generated titles', () => {
    const title = createWorkspaceConversationTitle('这是一个非常长的提示词用于验证对话标题不会无限占用侧栏空间并保持省略显示')
    expect(Array.from(title).length).toBeLessThanOrEqual(28)
    expect(title.endsWith('...')).toBe(true)
  })

  it('clears every conversation and active selection', () => {
    createWorkspaceConversation('image')
    createWorkspaceConversation('video')

    clearWorkspaceConversations()

    expect(getWorkspaceConversationState()).toEqual({
      conversations: [],
      activeIds: { image: null, video: null },
      sidebarCollapsed: false,
    })
  })
})
