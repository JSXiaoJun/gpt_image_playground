import { useMemo, useState } from 'react'
import type { WorkspaceConversation, WorkspaceMode } from '../types'
import { removeMultipleTasks, useStore } from '../store'
import { useWorkspaceConversations } from '../hooks/useWorkspaceConversations'
import { createWorkspaceConversation, deleteWorkspaceConversation, getWorkspaceConversationState, renameWorkspaceConversation, setWorkspaceSidebarCollapsed } from '../lib/workspaceConversations'
import { deleteVideoConversationData } from '../lib/videoWorkspaceStorage'
import { EditIcon, ImageIcon, PlusIcon, SidebarLeftIcon, TrashIcon, VideoIcon } from './icons'

interface WorkspaceConversationSidebarProps {
  workspaceMode: WorkspaceMode
  onSelect: (conversation: WorkspaceConversation) => void
  onCreate: (kind: WorkspaceMode) => void
}

function formatTime(value: number) {
  const date = new Date(value)
  const now = new Date()
  if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return date.toLocaleDateString([], { month: 'numeric', day: 'numeric' })
}

export default function WorkspaceConversationSidebar({ workspaceMode, onSelect, onCreate }: WorkspaceConversationSidebarProps) {
  const state = useWorkspaceConversations()
  const tasks = useStore((s) => s.tasks)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const deleteGalleryConversationDraft = useStore((s) => s.deleteGalleryConversationDraft)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')

  const conversations = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    return [...state.conversations]
      .filter((item) => !normalizedQuery || item.title.toLowerCase().includes(normalizedQuery))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }, [query, state.conversations])

  const confirmRename = () => {
    if (editingId && editingTitle.trim()) renameWorkspaceConversation(editingId, editingTitle)
    setEditingId(null)
  }

  const handleDelete = (conversation: WorkspaceConversation) => {
    setConfirmDialog({
      title: '删除对话',
      message: `确定删除「${conversation.title}」吗？该对话中的 ${conversation.taskCount} 条任务及其未提交草稿也会删除。`,
      confirmText: '删除对话',
      cancelText: '取消',
      tone: 'danger',
      action: () => {
        void (async () => {
          const wasActive = getWorkspaceConversationState().activeIds[conversation.kind] === conversation.id
          if (conversation.kind === 'image') {
            deleteWorkspaceConversation(conversation.id)
            let nextId = getWorkspaceConversationState().activeIds.image
            if (!nextId) nextId = createWorkspaceConversation('image')
            deleteGalleryConversationDraft(conversation.id, wasActive ? nextId : undefined)
            await removeMultipleTasks(tasks.filter((task) => task.workspaceConversationId === conversation.id).map((task) => task.id))
          } else {
            deleteVideoConversationData(conversation.id)
            window.dispatchEvent(new CustomEvent('workspace-video-conversation-deleted', { detail: conversation.id }))
            deleteWorkspaceConversation(conversation.id)
            if (!getWorkspaceConversationState().activeIds.video) createWorkspaceConversation('video')
          }
        })()
      },
    })
  }

  const renderPanel = (mobile = false) => (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-14 flex-none items-center gap-2 border-b border-gray-200 px-3 dark:border-white/[0.08]">
        <button type="button" onClick={() => mobile ? setMobileOpen(false) : setWorkspaceSidebarCollapsed(true)} title="收起对话列表" aria-label="收起对话列表" className="flex h-9 w-9 flex-none items-center justify-center rounded-lg text-gray-500 transition hover:bg-gray-100 hover:text-gray-800 dark:hover:bg-white/[0.06] dark:hover:text-gray-200"><SidebarLeftIcon className="h-5 w-5" /></button>
        <button type="button" onClick={() => onCreate(workspaceMode)} className="flex h-9 min-w-0 flex-1 items-center justify-center gap-2 rounded-lg bg-blue-600 px-3 text-sm font-medium text-white transition hover:bg-blue-700"><PlusIcon className="h-4 w-4" />开启新对话</button>
      </div>
      <div className="flex-none p-3">
        <label className="relative block"><svg className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" strokeWidth="2" /><path d="m20 20-4-4" strokeLinecap="round" strokeWidth="2" /></svg><input aria-label="搜索对话" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索对话..." className="h-10 w-full rounded-lg border border-gray-200 bg-gray-50 pl-9 pr-3 text-sm outline-none transition focus:border-blue-400 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-white" /></label>
      </div>
      <div className="px-4 pb-1 text-[11px] text-gray-400">最近对话</div>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-3">
        {!conversations.length && <p className="px-3 py-8 text-center text-xs text-gray-400">没有找到匹配的对话</p>}
        {conversations.map((item) => {
          const active = item.kind === workspaceMode && state.activeIds[item.kind] === item.id
          const Icon = item.kind === 'image' ? ImageIcon : VideoIcon
          return (
            <div key={item.id} className={`group flex min-h-16 items-center gap-2 rounded-lg px-2 transition ${active ? 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-300' : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/[0.04]'}`}>
              <Icon className="h-4 w-4 flex-none" />
              {editingId === item.id ? (
                <input autoFocus value={editingTitle} onChange={(e) => setEditingTitle(e.target.value)} onBlur={confirmRename} onKeyDown={(e) => { if (e.key === 'Enter') confirmRename(); if (e.key === 'Escape') setEditingId(null) }} className="h-8 min-w-0 flex-1 rounded border border-blue-300 bg-white px-2 text-sm text-gray-800 outline-none dark:bg-gray-900 dark:text-white" />
              ) : (
                <button type="button" aria-current={active ? 'page' : undefined} onClick={() => { onSelect(item); if (mobile) setMobileOpen(false) }} className="min-w-0 flex-1 py-2 text-left">
                  <span className="block truncate text-sm font-medium">{item.title}</span>
                  <span className="mt-0.5 flex items-center justify-between text-[11px] text-gray-400"><span>{item.taskCount} 条任务</span><span>{formatTime(item.updatedAt)}</span></span>
                </button>
              )}
              {editingId !== item.id && <div className="flex flex-none items-center opacity-100 lg:opacity-0 lg:transition lg:group-hover:opacity-100 lg:group-focus-within:opacity-100">
                <button type="button" onClick={() => { setEditingId(item.id); setEditingTitle(item.title) }} title="重命名对话" aria-label="重命名对话" className="flex h-8 w-8 items-center justify-center rounded text-gray-400 hover:bg-white hover:text-gray-700 dark:hover:bg-white/[0.08] dark:hover:text-gray-200"><EditIcon className="h-3.5 w-3.5" /></button>
                <button type="button" onClick={() => handleDelete(item)} title="删除对话" aria-label="删除对话" className="flex h-8 w-8 items-center justify-center rounded text-gray-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-500/10"><TrashIcon className="h-3.5 w-3.5" /></button>
              </div>}
            </div>
          )
        })}
      </div>
    </div>
  )

  return (
    <>
      <button type="button" onClick={() => setMobileOpen(true)} title="打开对话列表" aria-label="打开对话列表" className="fixed left-2 top-[4.25rem] z-30 flex h-9 w-9 items-center justify-center rounded-lg border border-gray-200 bg-white/90 text-gray-500 shadow-sm backdrop-blur lg:hidden dark:border-white/[0.08] dark:bg-gray-950/90 dark:text-gray-300"><SidebarLeftIcon className="h-5 w-5" /></button>
      {mobileOpen && <div className="fixed inset-0 z-40 bg-black/35 backdrop-blur-sm lg:hidden" onClick={() => setMobileOpen(false)} />}
      <aside className={`fixed inset-y-0 left-0 z-50 w-[min(84vw,320px)] border-r border-gray-200 bg-white shadow-2xl transition-transform duration-200 lg:hidden dark:border-white/[0.08] dark:bg-gray-950 ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`}>{renderPanel(true)}</aside>
      <aside className={`fixed bottom-0 left-0 top-14 z-30 hidden border-r border-gray-200 bg-white/95 backdrop-blur transition-[width] duration-200 lg:block dark:border-white/[0.08] dark:bg-gray-950/95 ${state.sidebarCollapsed ? 'w-14' : 'w-72'}`}>
        {state.sidebarCollapsed ? (
          <div className="flex h-full flex-col items-center gap-2 py-3">
            <button type="button" onClick={() => setWorkspaceSidebarCollapsed(false)} title="展开对话列表" aria-label="展开对话列表" className="flex h-9 w-9 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 dark:hover:bg-white/[0.06]"><SidebarLeftIcon className="h-5 w-5 rotate-180" /></button>
            <button type="button" onClick={() => onCreate(workspaceMode)} title="开启新对话" aria-label="开启新对话" className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-600 text-white hover:bg-blue-700"><PlusIcon className="h-4 w-4" /></button>
            <div className="my-1 h-px w-7 bg-gray-200 dark:bg-white/[0.08]" />
            {(['image', 'video'] as const).map((kind) => {
              const active = state.conversations.find((item) => item.id === state.activeIds[kind])
              if (!active) return null
              const Icon = kind === 'image' ? ImageIcon : VideoIcon
              return <button key={kind} type="button" onClick={() => onSelect(active)} title={active.title} aria-label={active.title} className={`flex h-9 w-9 items-center justify-center rounded-lg ${workspaceMode === kind ? 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-300' : 'text-gray-400 hover:bg-gray-100 dark:hover:bg-white/[0.06]'}`}><Icon className="h-4 w-4" /></button>
            })}
          </div>
        ) : renderPanel()}
      </aside>
    </>
  )
}
