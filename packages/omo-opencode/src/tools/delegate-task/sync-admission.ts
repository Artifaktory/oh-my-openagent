import type { BackgroundManager } from "../../features/background-agent/manager"

export interface SyncAdmissionRecord {
  readonly invocationId: string
  readonly waiterId: string
  readonly signal: AbortSignal
  readonly deadline: number
}

export interface SyncExecutionControl {
  readonly signal: AbortSignal
  readonly check: () => void
  readonly remaining: () => number
}

export class SyncAdmissionError extends Error {
  constructor(readonly code: "sync_admission_cancelled" | "sync_admission_expired" | "sync_admission_invalid") {
    super(code)
    this.name = "SyncAdmissionError"
  }
}

type AdmissionManager = Pick<BackgroundManager,
  "acquireSyncSubagentConcurrency" | "releaseSyncSubagentConcurrency" | "cancelSyncSubagentConcurrencyWaiter">

export function createSyncAdmission(record: SyncAdmissionRecord, parentSignal?: AbortSignal) {
  const { signal, deadline, waiterId } = record
  if (!record.invocationId || record.invocationId.length > 256 || !waiterId || waiterId.length > 256
    || !Number.isSafeInteger(deadline) || deadline - Date.now() > 120000) {
    throw new SyncAdmissionError("sync_admission_invalid")
  }
  let closed = false
  const controller = new AbortController()
  let failure: SyncAdmissionError | undefined
  const cancelled = Promise.withResolvers<never>()
  void cancelled.promise.catch(() => undefined)
  const listeners = new Set<() => void>()
  const cancel = (code: "sync_admission_cancelled" | "sync_admission_expired") => {
    if (failure) return
    failure = new SyncAdmissionError(code)
    controller.abort(failure)
    for (const listener of listeners) listener()
    cancelled.reject(failure)
  }
  const onAbort = () => cancel("sync_admission_cancelled")
  signal.addEventListener("abort", onAbort, { once: true })
  if (parentSignal !== signal) parentSignal?.addEventListener("abort", onAbort, { once: true })
  const timer = setTimeout(() => cancel("sync_admission_expired"), Math.max(0, deadline - Date.now()))
  if (signal.aborted || parentSignal?.aborted) onAbort()

  const check = () => {
    if (signal.aborted || parentSignal?.aborted) onAbort()
    if (Date.now() >= deadline) cancel("sync_admission_expired")
    if (failure) throw failure
    if (closed) throw new SyncAdmissionError("sync_admission_cancelled")
  }

  async function run<T>(action: () => Promise<T>, onLate?: (value: T) => void): Promise<T> {
    check()
    let captured: { value: T } | undefined
    let abandoned = false
    const abandon = (value: T) => {
      if (abandoned) return
      abandoned = true
      onLate?.(value)
    }
    const operation = action().then(value => {
      captured = { value }
      try { check() } catch (error) { abandon(value); throw error }
      return value
    })
    try {
      const value = await Promise.race([operation, cancelled.promise])
      check()
      return value
    } catch (error) {
      if (captured) abandon(captured.value)
      throw error
    }
  }

  return {
    signal: controller.signal,
    check,
    run,
    remaining: () => { check(); return Math.max(1, deadline - Date.now()) },
    async acquire(manager: AdmissionManager, model: string): Promise<void> {
      check()
      if (typeof manager.cancelSyncSubagentConcurrencyWaiter !== "function") throw new SyncAdmissionError("sync_admission_invalid")
      let owned = false
      let transferred = false
      const cancelWaiter = () => { manager.cancelSyncSubagentConcurrencyWaiter(model, waiterId) }
      listeners.add(cancelWaiter)
      try {
        const acquisition = manager.acquireSyncSubagentConcurrency(model, waiterId).then(() => {
          owned = true
          try { check() } catch (error) {
            owned = false
            manager.releaseSyncSubagentConcurrency(model)
            throw error
          }
        })
        // Abort can occur synchronously during enqueue; repeat targeted removal after registration.
        if (failure) cancelWaiter()
        await Promise.race([acquisition, cancelled.promise])
        check()
        transferred = true
      } catch (error) {
        if (failure) throw failure
        throw error
      } finally {
        listeners.delete(cancelWaiter)
        if (owned && !transferred) manager.releaseSyncSubagentConcurrency(model)
      }
    },
    dispose() {
      closed = true
      controller.abort()
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      if (parentSignal !== signal) parentSignal?.removeEventListener("abort", onAbort)
      listeners.clear()
    },
  }
}
