import { handedBackSyncSessions, subagentSessions } from "../../features/claude-code-session-state"
import { getTaskToastManager } from "../../features/task-toast-manager"
import type { ModelFallbackInfo } from "../../features/task-toast-manager/types"
import type { FallbackEntry } from "../../shared/model-requirements"
import { log } from "../../shared/logger"
import { scheduleSyncSessionDeletion } from "./sync-session-cleanup"
import { formatDetailedError } from "./error-formatting"
import type { ExecutorContext, ParentContext } from "./executor-types"
import { reserveSyncSubagentSpawn } from "./sync-spawn-reservation"
import { type SyncTaskDeps, syncTaskDeps } from "./sync-task-deps"
import { publishSyncTaskMetadata } from "./sync-task-metadata"
import { runSyncTaskLoop } from "./sync-task-runner"
import { cleanupSyncSessionSideEffects, registerSyncSessionSideEffects } from "./sync-session-lifecycle"
import type { DelegatedModelConfig, DelegateTaskArgs, ToolContextWithMetadata } from "./types"
import { createSyncAdmission, SyncAdmissionError, type SyncAdmissionRecord } from "./sync-admission"

export async function executeSyncTask(
  args: DelegateTaskArgs,
  ctx: ToolContextWithMetadata,
  executorCtx: ExecutorContext,
  parentContext: ParentContext,
  agentToUse: string,
  categoryModel: DelegatedModelConfig | undefined,
  systemContent: string | undefined,
  modelInfo?: ModelFallbackInfo,
  fallbackChain?: FallbackEntry[],
  deps: SyncTaskDeps = syncTaskDeps,
  admissionRecord?: SyncAdmissionRecord,
): Promise<string> {
  const { client, directory, syncPollTimeoutMs, taskCleanupDelayMs } = executorCtx
  const toastManager = getTaskToastManager()
  let taskId: string | undefined
  let syncSessionID: string | undefined
  let spawnReservation:
    | Awaited<ReturnType<ExecutorContext["manager"]["reserveSubagentSpawn"]>>
    | undefined
  let concurrencyAcquired = false
  let concurrencyModel = categoryModel && typeof categoryModel.providerID === "string" && typeof categoryModel.modelID === "string"
    ? `${categoryModel.providerID}/${categoryModel.modelID}`
    : typeof agentToUse === "string" ? agentToUse : "default"
  const manager = executorCtx?.manager
  let admission: ReturnType<typeof createSyncAdmission> | undefined
  const abandonLateSession = (result: Awaited<ReturnType<SyncTaskDeps["createSyncSession"]>>) => {
    if (!result.ok) return
    if (typeof client?.session?.abort === "function") {
      void client.session.abort({ path: { id: result.sessionID } }).catch(() => {
        log("[task] Late cancelled sync session abort failed")
      })
    }
    scheduleSyncSessionDeletion(client, result.sessionID, taskCleanupDelayMs)
  }

  try {
    admission = admissionRecord ? createSyncAdmission(admissionRecord, ctx.abort) : undefined
    admission?.check()
    if (!subagentSessions.has(parentContext.sessionID) && typeof manager?.acquireSyncSubagentConcurrency === "function") {
      if (admission) await admission.acquire(manager, concurrencyModel)
      else await manager.acquireSyncSubagentConcurrency(concurrencyModel)
      concurrencyAcquired = true
    }
    admission?.check()
    const spawn = admission
      ? await admission.run(() => reserveSyncSubagentSpawn(executorCtx, parentContext), late => late.reservation?.rollback())
      : await reserveSyncSubagentSpawn(executorCtx, parentContext)
    spawnReservation = spawn.reservation
    const { spawnContext } = spawn

    const guard = admission
    const activeDeps: SyncTaskDeps = guard ? {
      ...deps,
      createSyncSession: (currentClient, input) => guard.run(() => deps.createSyncSession(currentClient, { ...input, control: guard }), abandonLateSession),
      sendSyncPrompt: (currentClient, input, promptDeps) => guard.run(() => deps.sendSyncPrompt(currentClient, { ...input, control: guard }, promptDeps)),
      pollSyncSession: (toolContext, currentClient, options, timeout) => guard.run(() =>
        deps.pollSyncSession(toolContext, currentClient, options, Math.min(timeout ?? guard.remaining(), guard.remaining()))),
      fetchSyncResult: (...parameters) => guard.run(() => deps.fetchSyncResult(...parameters)),
      onModelChange: async model => {
        guard.check()
        const nextKey = `${model.providerID}/${model.modelID}`
        if (concurrencyAcquired && nextKey !== concurrencyModel) {
          manager.releaseSyncSubagentConcurrency(concurrencyModel)
          concurrencyAcquired = false
          await guard.acquire(manager, nextKey)
          concurrencyModel = nextKey
          concurrencyAcquired = true
        }
        await deps.onModelChange?.(model)
        guard.check()
      },
    } : deps

    const createSessionResult = await activeDeps.createSyncSession(client, {
      parentSessionID: parentContext.sessionID,
      agentToUse,
      description: args.description,
      defaultDirectory: directory,
      category: args.category,
      categoryModel,
    })

    if (!createSessionResult.ok) {
      spawnReservation?.rollback()
      return createSessionResult.error
    }

    const sessionID = createSessionResult.sessionID
    spawnReservation?.commit()
    syncSessionID = sessionID

    const registerSyncSession = async (newSessionID: string): Promise<void> => {
      admission?.check()
      syncSessionID = newSessionID
      const register = () => registerSyncSessionSideEffects({
        args,
        executorCtx,
        sessionID: newSessionID,
        parentContext,
        agentToUse,
        categoryModel,
        fallbackChain,
        systemContent,
      })
      if (admission) await admission.run(register)
      else await register()
    }

    const publishSyncMetadata = async (
      currentSessionID: string,
      currentModel: DelegatedModelConfig | undefined,
      spawnDepth: number,
    ): Promise<void> => {
      admission?.check()
      const publish = () => publishSyncTaskMetadata({
        args,
        ctx,
        currentSessionID,
        currentModel,
        parentContext,
        agentToUse,
        spawnDepth,
      })
      if (admission) await admission.run(publish)
      else await publish()
    }

    await registerSyncSession(sessionID)

    taskId = `sync_${sessionID.slice(0, 8)}`
    const startTime = new Date()

    if (toastManager) {
      toastManager.addTask({
        id: taskId,
        sessionID,
        description: args.description,
        agent: agentToUse,
        isBackground: false,
        category: args.category,
        skills: args.load_skills,
        modelInfo,
      })
    }
    await publishSyncMetadata(sessionID, categoryModel, spawnContext.childDepth)

    const setSyncSessionID = (currentSessionID: string): void => {
      syncSessionID = currentSessionID
    }

    const cleanupRetrySession = (currentSessionID: string): void => {
      cleanupSyncSessionSideEffects(currentSessionID, executorCtx)
      if (admission) {
        deps.onSessionAbandoned?.(currentSessionID)
        void client.session.abort({ path: { id: currentSessionID } }).catch(() => log("[task] Retry session abort failed"))
        scheduleSyncSessionDeletion(client, currentSessionID, taskCleanupDelayMs)
      }
    }

    try {
      const result = await runSyncTaskLoop({
        args,
        ctx,
        executorCtx: {
          ...executorCtx,
          directory: createSessionResult.parentDirectory,
        },
        parentContext,
        agentToUse,
        categoryModel,
        fallbackChain,
        deps: activeDeps,
        sessionID,
        spawnDepth: spawnContext.childDepth,
        taskId,
        startTime,
        syncPollTimeoutMs,
        systemContent,
        toastManager: toastManager ?? undefined,
        modelInfo,
        registerSyncSession,
        publishSyncMetadata,
        cleanupRetrySession,
        setSyncSessionID,
      })
      admission?.check()
      return result
    } finally {
      if (toastManager && taskId !== undefined) {
        toastManager.removeTask(taskId)
      }
    }
  } catch (error) {
    spawnReservation?.rollback()
    if (error instanceof SyncAdmissionError) return JSON.stringify({ error: error.code })
    const errorToFormat = error instanceof Error ? error : String(error)
    return formatDetailedError(errorToFormat, {
      operation: "Execute task",
      args,
      sessionID: syncSessionID,
      agent: agentToUse,
      category: args.category,
    })
  } finally {
    admission?.dispose()
    if (syncSessionID) {
      cleanupSyncSessionSideEffects(syncSessionID, executorCtx)
      handedBackSyncSessions.add(syncSessionID)

      // Prevent todo-continuation-enforcer from re-awakening a completed sync subagent.
      // When a sync subagent finishes, its session may still exist and have incomplete
      // todos; without an explicit abort, the continuation hook sees session.idle and
      // injects a continuation prompt, causing the subagent to resume after the parent
      // has already moved on. This creates a race where two agents work concurrently.
      // Aborting an already-idle session emits no error event (opencode re-publishes
      // session.idle), so handedBackSyncSessions is the signal the enforcer keys on;
      // the abort still cancels the child's opencode-side background jobs.
      if (typeof client?.session?.abort === "function") {
        void client.session.abort({ path: { id: syncSessionID } }).catch((error: unknown) => {
          log(`[task] Failed to abort completed sync session:`, error)
        })
      }
      scheduleSyncSessionDeletion(client, syncSessionID, taskCleanupDelayMs)
    }
    if (concurrencyAcquired && typeof manager?.releaseSyncSubagentConcurrency === "function") {
      manager.releaseSyncSubagentConcurrency(concurrencyModel)
    }
  }
}
