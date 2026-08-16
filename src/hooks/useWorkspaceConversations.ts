import { useSyncExternalStore } from 'react'
import { getWorkspaceConversationState, subscribeWorkspaceConversations } from '../lib/workspaceConversations'

export function useWorkspaceConversations() {
  return useSyncExternalStore(subscribeWorkspaceConversations, getWorkspaceConversationState, getWorkspaceConversationState)
}
