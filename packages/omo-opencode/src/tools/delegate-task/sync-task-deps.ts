import { isProviderExhaustionFallbackEligible } from "@oh-my-opencode/model-core"
import { createSyncSession } from "./sync-session-creator"
import { sendSyncPrompt } from "./sync-prompt-sender"
import { pollSyncSession } from "./sync-session-poller"
import { fetchSyncResult } from "./sync-result-fetcher"
import type { DelegatedModelConfig } from "./types"

export type SyncTaskDeps = {
  readonly createSyncSession: typeof createSyncSession
  readonly sendSyncPrompt: typeof sendSyncPrompt
  readonly pollSyncSession: typeof pollSyncSession
  readonly fetchSyncResult: typeof fetchSyncResult
  readonly isProviderExhaustionFallbackEligible?: typeof isProviderExhaustionFallbackEligible
  readonly capturedFallbackModels?: readonly DelegatedModelConfig[]
  readonly onModelChange?: (model: DelegatedModelConfig) => Promise<void>
  readonly onSessionAbandoned?: (sessionID: string) => void
  readonly onNativeCompleted?: (sessionID: string) => void
}

export const syncTaskDeps: SyncTaskDeps = {
  createSyncSession,
  sendSyncPrompt,
  pollSyncSession,
  fetchSyncResult,
  isProviderExhaustionFallbackEligible,
}
