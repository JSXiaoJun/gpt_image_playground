import type { WorkspaceConversation, WorkspaceMode } from '../types'

export interface WorkspaceConversationState {
  conversations: WorkspaceConversation[]
  activeIds: Record<WorkspaceMode, string | null>
  sidebarCollapsed: boolean
}

const STORAGE_KEY = 'gpt-image-playground-workspace-conversations-v1'
const DEFAULT_STATE: WorkspaceConversationState = {
  conversations: [],
  activeIds: { image: null, video: null },
  sidebarCollapsed: false,
}
const listeners = new Set<() => void>()
let cachedState: WorkspaceConversationState | null = null

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function createId() {
  return globalThis.crypto?.randomUUID?.() ?? `workspace-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function normalizeTitle(value: unknown) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, 60) : ''
}

export function createWorkspaceConversationTitle(prompt: string) {
  const title = prompt.trim().replace(/\s+/g, ' ')
  if (!title) return '新对话'
  const chars = Array.from(title)
  return chars.length <= 28 ? title : `${chars.slice(0, 25).join('')}...`
}

function normalizeState(value: unknown): WorkspaceConversationState {
  if (!isRecord(value)) return DEFAULT_STATE
  const ids = new Set<string>()
  const conversations = Array.isArray(value.conversations) ? value.conversations.flatMap((item) => {
    if (!isRecord(item) || typeof item.id !== 'string' || ids.has(item.id)) return []
    if (item.kind !== 'image' && item.kind !== 'video') return []
    const title = normalizeTitle(item.title)
    if (!title) return []
    ids.add(item.id)
    const now = Date.now()
    return [{
      id: item.id,
      kind: item.kind,
      title,
      untitled: typeof item.untitled === 'boolean' ? item.untitled : title === '新对话',
      taskCount: typeof item.taskCount === 'number' && item.taskCount >= 0 ? Math.floor(item.taskCount) : 0,
      createdAt: typeof item.createdAt === 'number' ? item.createdAt : now,
      updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : now,
    } satisfies WorkspaceConversation]
  }) : []
  const activeIds = isRecord(value.activeIds) ? value.activeIds : {}
  return {
    conversations,
    activeIds: {
      image: typeof activeIds.image === 'string' && conversations.some((item) => item.id === activeIds.image && item.kind === 'image') ? activeIds.image : null,
      video: typeof activeIds.video === 'string' && conversations.some((item) => item.id === activeIds.video && item.kind === 'video') ? activeIds.video : null,
    },
    sidebarCollapsed: Boolean(value.sidebarCollapsed),
  }
}

function readState() {
  if (cachedState) return cachedState
  if (typeof localStorage === 'undefined') {
    cachedState = DEFAULT_STATE
    return cachedState
  }
  try {
    cachedState = normalizeState(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'))
  } catch {
    cachedState = DEFAULT_STATE
  }
  return cachedState
}

function updateState(updater: (state: WorkspaceConversationState) => WorkspaceConversationState) {
  cachedState = updater(readState())
  if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(cachedState))
  for (const listener of listeners) listener()
  return cachedState
}

export function getWorkspaceConversationState() {
  return readState()
}

export function subscribeWorkspaceConversations(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function createWorkspaceConversation(kind: WorkspaceMode, title = '新对话', activate = true) {
  const now = Date.now()
  const conversation: WorkspaceConversation = {
    id: createId(),
    kind,
    title: normalizeTitle(title) || '新对话',
    untitled: title === '新对话',
    taskCount: 0,
    createdAt: now,
    updatedAt: now,
  }
  updateState((state) => ({
    ...state,
    conversations: [conversation, ...state.conversations],
    activeIds: activate ? { ...state.activeIds, [kind]: conversation.id } : state.activeIds,
  }))
  return conversation.id
}

export function ensureWorkspaceConversation(kind: WorkspaceMode, title = '新对话') {
  const state = readState()
  const active = state.activeIds[kind]
  if (active && state.conversations.some((item) => item.id === active && item.kind === kind)) return active
  const latest = state.conversations
    .filter((item) => item.kind === kind)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]
  if (latest) {
    updateState((current) => ({ ...current, activeIds: { ...current.activeIds, [kind]: latest.id } }))
    return latest.id
  }
  return createWorkspaceConversation(kind, title)
}

export function selectWorkspaceConversation(id: string) {
  const conversation = readState().conversations.find((item) => item.id === id)
  if (!conversation) return null
  updateState((state) => ({ ...state, activeIds: { ...state.activeIds, [conversation.kind]: id } }))
  return conversation
}

export function renameWorkspaceConversation(id: string, title: string) {
  const normalized = normalizeTitle(title)
  if (!normalized) return
  updateState((state) => ({
    ...state,
    conversations: state.conversations.map((item) => item.id === id ? { ...item, title: normalized, untitled: false, updatedAt: Date.now() } : item),
  }))
}

export function importWorkspaceConversations(value: unknown) {
  const imported = normalizeState({ conversations: value, activeIds: {}, sidebarCollapsed: false }).conversations
  if (!imported.length) return
  updateState((state) => {
    const existingIds = new Set(state.conversations.map((item) => item.id))
    return { ...state, conversations: [...state.conversations, ...imported.filter((item) => !existingIds.has(item.id))] }
  })
}

export function deleteWorkspaceConversation(id: string) {
  updateState((state) => {
    const deleted = state.conversations.find((item) => item.id === id)
    if (!deleted) return state
    const conversations = state.conversations.filter((item) => item.id !== id)
    const replacement = conversations.filter((item) => item.kind === deleted.kind).sort((a, b) => b.updatedAt - a.updatedAt)[0]
    return {
      ...state,
      conversations,
      activeIds: state.activeIds[deleted.kind] === id
        ? { ...state.activeIds, [deleted.kind]: replacement?.id ?? null }
        : state.activeIds,
    }
  })
}

export function touchWorkspaceConversation(id: string, prompt?: string) {
  updateState((state) => ({
    ...state,
    conversations: state.conversations.map((item) => item.id === id ? {
      ...item,
      ...(item.untitled && prompt?.trim() ? { title: createWorkspaceConversationTitle(prompt), untitled: false } : {}),
      updatedAt: Date.now(),
    } : item),
  }))
}

export function syncWorkspaceConversationStats(kind: WorkspaceMode, stats: Record<string, { taskCount: number; updatedAt: number }>) {
  updateState((state) => {
    let changed = false
    const conversations = state.conversations.map((item) => {
      if (item.kind !== kind) return item
      const next = stats[item.id] ?? { taskCount: 0, updatedAt: item.updatedAt }
      if (item.taskCount === next.taskCount && item.updatedAt >= next.updatedAt) return item
      changed = true
      return { ...item, taskCount: next.taskCount, updatedAt: Math.max(item.updatedAt, next.updatedAt) }
    })
    return changed ? { ...state, conversations } : state
  })
}

export function getActiveWorkspaceConversationId(kind: WorkspaceMode) {
  return readState().activeIds[kind]
}

export function setWorkspaceSidebarCollapsed(sidebarCollapsed: boolean) {
  updateState((state) => ({ ...state, sidebarCollapsed }))
}

export function clearWorkspaceConversations() {
  updateState(() => ({
    conversations: [],
    activeIds: { image: null, video: null },
    sidebarCollapsed: false,
  }))
}

export function resetWorkspaceConversationsForTests(state: WorkspaceConversationState = DEFAULT_STATE) {
  cachedState = state
}
