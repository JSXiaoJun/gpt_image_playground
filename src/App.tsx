import { useEffect, useState } from 'react'
import { initStore } from './store'
import { useStore } from './store'
import { activateFirstImportedProfile, buildSettingsFromUrlParams, clearUrlSettingParams, hasUrlSettingParams } from './lib/urlSettings'
import { isDefaultConfigOnlyEnabled, mergeImportedSettings } from './lib/apiProfiles'
import { getCustomProviderConfigUrl, loadCustomProviderSettingsFromUrl } from './lib/customProviderConfigUrl'
import { useDockerApiUrlMigrationNotice } from './hooks/useDockerApiUrlMigrationNotice'
import type { AppSettings, WorkspaceConversation, WorkspaceMode } from './types'
import Header from './components/Header'
import SearchBar from './components/SearchBar'
import TaskGrid from './components/TaskGrid'
// Agent 模式暂时隐藏，保留文件但不挂载入口。
// import AgentWorkspace from './components/AgentWorkspace'
import InputBar from './components/InputBar'
import DetailModal from './components/DetailModal'
import Lightbox from './components/Lightbox'
import SettingsModal from './components/SettingsModal'
import ConfirmDialog from './components/ConfirmDialog'
import Toast from './components/Toast'
import MaskEditorModal from './components/MaskEditorModal'
import ImageContextMenu from './components/ImageContextMenu'
import { FavoriteCollectionPickerModal, FavoriteCollectionsView, ManageCollectionsModal } from './components/FavoriteCollections'
import { useGlobalClickSuppression } from './lib/clickSuppression'
import VideoWorkspace from './components/VideoWorkspace'
import WorkspaceConversationSidebar from './components/WorkspaceConversationSidebar'
import { useWorkspaceConversations } from './hooks/useWorkspaceConversations'
import { createWorkspaceConversation, ensureWorkspaceConversation, getActiveWorkspaceConversationId, selectWorkspaceConversation, syncWorkspaceConversationStats } from './lib/workspaceConversations'
import { migrateStoredVideoConversations } from './lib/videoWorkspaceStorage'

let customProviderConfigUrlImportStarted = false

export default function App() {
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>(() => {
    migrateStoredVideoConversations()
    const mode = localStorage.getItem('gpt-image-playground-workspace-mode') === 'video' ? 'video' : 'image'
    if (mode === 'video') ensureWorkspaceConversation('video')
    return mode
  })
  const workspaceConversationState = useWorkspaceConversations()
  const setSettings = useStore((s) => s.setSettings)
  const setAppMode = useStore((s) => s.setAppMode)
  const filterFavorite = useStore((s) => s.filterFavorite)
  const activeFavoriteCollectionId = useStore((s) => s.activeFavoriteCollectionId)
  const tasks = useStore((s) => s.tasks)
  const hasRunningTasks = useStore((s) => s.tasks.some((task) => task.status === 'running' || task.falRecoverable || task.customRecoverable))
  useDockerApiUrlMigrationNotice()
  useGlobalClickSuppression()

  useEffect(() => {
    const stats: Record<string, { taskCount: number; updatedAt: number }> = {}
    for (const task of tasks) {
      if (!task.workspaceConversationId) continue
      const current = stats[task.workspaceConversationId]
      stats[task.workspaceConversationId] = {
        taskCount: (current?.taskCount ?? 0) + 1,
        updatedAt: Math.max(current?.updatedAt ?? 0, task.finishedAt ?? task.createdAt),
      }
    }
    syncWorkspaceConversationStats('image', stats)
  }, [tasks])

  const selectConversation = (conversation: WorkspaceConversation) => {
    const previousImageId = getActiveWorkspaceConversationId('image')
    if (conversation.kind === 'image' && previousImageId !== conversation.id) {
      useStore.getState().switchGalleryConversation(previousImageId, conversation.id)
    }
    selectWorkspaceConversation(conversation.id)
    setWorkspaceMode(conversation.kind)
  }

  const createConversation = (kind: WorkspaceMode) => {
    const previousImageId = getActiveWorkspaceConversationId('image')
    const id = createWorkspaceConversation(kind)
    if (kind === 'image') useStore.getState().switchGalleryConversation(previousImageId, id)
    setWorkspaceMode(kind)
  }

  const handleWorkspaceModeChange = (kind: WorkspaceMode) => {
    const previousImageId = getActiveWorkspaceConversationId('image')
    const id = ensureWorkspaceConversation(kind)
    if (kind === 'image' && previousImageId !== id) useStore.getState().switchGalleryConversation(previousImageId, id)
    setWorkspaceMode(kind)
  }

  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search)
    const customProviderConfigUrl = getCustomProviderConfigUrl()
    const defaultConfigOnly = isDefaultConfigOnlyEnabled()

    const applyUrlSettings = (baseSettings: Partial<AppSettings>) => {
      const nextSettings = buildSettingsFromUrlParams(baseSettings, searchParams)
      return Object.keys(nextSettings).length ? nextSettings : baseSettings
    }

    const clearAppliedUrlSettings = () => {
      if (!hasUrlSettingParams(searchParams)) return

      clearUrlSettingParams(searchParams)

      const nextSearch = searchParams.toString()
      const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}${window.location.hash}`
      window.history.replaceState(null, '', nextUrl)
    }

    const initializeStore = () => {
      void initStore().catch((error) => {
        console.error('Failed to initialize local data:', error)
        useStore.getState().showToast('本地历史数据加载失败，请刷新页面重试', 'error')
      })
    }

    if (customProviderConfigUrl && defaultConfigOnly && !customProviderConfigUrlImportStarted) {
      customProviderConfigUrlImportStarted = true
      void loadCustomProviderSettingsFromUrl(customProviderConfigUrl)
        .then((importedSettings) => {
          const state = useStore.getState()
          const baseSettings = importedSettings
            ? activateFirstImportedProfile(mergeImportedSettings(state.settings, importedSettings), importedSettings)
            : state.settings
          state.setSettings(applyUrlSettings(baseSettings))
          clearAppliedUrlSettings()
        })
        .catch((error) => {
          console.warn('Failed to import custom provider config URL:', error)
          const state = useStore.getState()
          state.setSettings(applyUrlSettings(state.settings))
          clearAppliedUrlSettings()
        })

      initializeStore()
      return
    }

    const nextSettings = buildSettingsFromUrlParams(useStore.getState().settings, searchParams)

    setSettings(nextSettings)

    clearAppliedUrlSettings()

    if (customProviderConfigUrl && !customProviderConfigUrlImportStarted) {
      customProviderConfigUrlImportStarted = true
      void loadCustomProviderSettingsFromUrl(customProviderConfigUrl)
        .then((importedSettings) => {
          if (!importedSettings) return
          const state = useStore.getState()
          state.setSettings(mergeImportedSettings(state.settings, importedSettings))
        })
        .catch((error) => {
          console.warn('Failed to import custom provider config URL:', error)
        })
    }

    initializeStore()
  }, [setSettings])

  useEffect(() => {
    setAppMode('gallery')
  }, [setAppMode])

  useEffect(() => {
    localStorage.setItem('gpt-image-playground-workspace-mode', workspaceMode)
  }, [workspaceMode])

  useEffect(() => {
    if (!hasRunningTasks) return

    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = '图片仍在生成中，刷新或关闭页面后当前结果可能无法取回。'
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [hasRunningTasks])

  useEffect(() => {
    const preventPageImageDrag = (e: DragEvent) => {
      if ((e.target as HTMLElement | null)?.closest('img')) {
        e.preventDefault()
      }
    }

    document.addEventListener('dragstart', preventPageImageDrag)
    return () => document.removeEventListener('dragstart', preventPageImageDrag)
  }, [])

  return (
    <>
      <Header workspaceMode={workspaceMode} onWorkspaceModeChange={handleWorkspaceModeChange} />
      <WorkspaceConversationSidebar workspaceMode={workspaceMode} onSelect={selectConversation} onCreate={createConversation} />
      <div className={`transition-[padding] duration-200 ${workspaceConversationState.sidebarCollapsed ? 'lg:pl-14' : 'lg:pl-72'}`}>
        {workspaceMode === 'video' ? (
          <VideoWorkspace />
        ) : (
          <>
            {/* Agent 模式暂时注释掉，只保留画廊模式。 */}
            <main data-home-main data-drag-select-surface className="pb-48">
              <div className="safe-area-x max-w-7xl mx-auto">
                <SearchBar />
                {filterFavorite && !activeFavoriteCollectionId ? <FavoriteCollectionsView /> : <TaskGrid />}
              </div>
            </main>
            <InputBar />
            <DetailModal />
            <Lightbox />
          </>
        )}
      </div>
      <SettingsModal />
      <ConfirmDialog />
      <FavoriteCollectionPickerModal />
      <ManageCollectionsModal />
      <Toast />
      <MaskEditorModal />
      <ImageContextMenu />
    </>
  )
}
