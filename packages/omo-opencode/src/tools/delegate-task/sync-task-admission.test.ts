import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { BackgroundManager } from "../../features/background-agent/manager"
import type { ExecutorContext } from "./executor-types"
import { executeSyncTask } from "./sync-task"
import type { SyncTaskDeps } from "./sync-task-deps"
import type { ToolContextWithMetadata } from "./types"

const managers: BackgroundManager[] = []
afterEach(async () => {
  mock.restore()
  await Promise.all(managers.splice(0).map(manager => manager.shutdown()))
})

function fixture(providerLimit = false) {
  const aborted = Promise.withResolvers<void>()
  const abort = mock(async () => { aborted.resolve(); return { data: true } })
  const client = { session: { get: async () => ({ data: { id: "admission-parent" } }), abort } }
  const manager = new BackgroundManager({
    pluginContext: { client, directory: process.cwd() } as unknown as PluginInput,
    config: providerLimit ? { providerConcurrency: { test: 1 } } : { modelConcurrency: { "test/one": 1 } },
    log: () => {},
  })
  managers.push(manager)
  const create = mock<SyncTaskDeps["createSyncSession"]>(async () => ({ ok: false, error: "fixture_session_rejected" }))
  const send = mock(async () => null)
  const deps: SyncTaskDeps = {
    createSyncSession: create, sendSyncPrompt: send, pollSyncSession: async () => null,
    fetchSyncResult: async () => ({ ok: true, textContent: "unused" }),
  }
  const controller = new AbortController()
  const run = (deadline = Date.now() + 5000) => executeSyncTask(
    { description: "admission", prompt: "data", load_skills: [], run_in_background: false },
    { sessionID: "admission-parent", callID: "admission-call", abort: controller.signal, metadata: () => {} } as ToolContextWithMetadata,
    { manager, client, directory: process.cwd() } as unknown as ExecutorContext,
    { sessionID: "admission-parent", messageID: "parent-message" }, "test-agent",
    { providerID: "test", modelID: "one" }, undefined, undefined, undefined, deps,
    { invocationId: "invocation-test", waiterId: "waiter-test", signal: controller.signal, deadline },
  )
  return { manager, controller, create, send, run, deps, abort, aborted }
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("native admission did not settle")), 1500)
    })])
  } finally { clearTimeout(timer) }
}

describe("executeSyncTask native cancellation admission", () => {
  test("rejects already-aborted and already-expired work before enqueue", async () => {
    // given
    const cancelled = fixture()
    const expired = fixture()
    const acquireCancelled = spyOn(cancelled.manager, "acquireSyncSubagentConcurrency")
    const acquireExpired = spyOn(expired.manager, "acquireSyncSubagentConcurrency")
    // when
    cancelled.controller.abort()
    // then
    expect(await cancelled.run()).toContain("sync_admission_cancelled")
    expect(await expired.run(Date.now() - 1)).toContain("sync_admission_expired")
    expect(acquireCancelled).not.toHaveBeenCalled()
    expect(acquireExpired).not.toHaveBeenCalled()
    expect(cancelled.create).not.toHaveBeenCalled()
    expect(expired.create).not.toHaveBeenCalled()
  })

  test("queued deadline expiry removes its waiter without a late session", async () => {
    // given: time is the behavior under test
    const f = fixture()
    await f.manager.acquireSyncSubagentConcurrency("test/one", "holder")
    // when
    const result = await bounded(f.run(Date.now() + 30))
    // then
    expect(result).toContain("sync_admission_expired")
    f.manager.releaseSyncSubagentConcurrency("test/one")
    await bounded(f.manager.acquireSyncSubagentConcurrency("test/one", "probe"))
    expect(f.create).not.toHaveBeenCalled()
    f.manager.releaseSyncSubagentConcurrency("test/one")
  })

  for (const race of ["before-enqueue", "after-enqueue", "grant"] as const) {
    test(`cancellation at ${race} conserves exactly one capacity lease`, async () => {
      // given
      const f = fixture()
      await f.manager.acquireSyncSubagentConcurrency("test/one", "holder")
      const acquire = f.manager.acquireSyncSubagentConcurrency.bind(f.manager)
      const releases = spyOn(f.manager, "releaseSyncSubagentConcurrency")
      spyOn(f.manager, "acquireSyncSubagentConcurrency").mockImplementation((model, id) => {
        if (race === "before-enqueue") f.controller.abort()
        const result = acquire(model, id)
        if (race === "grant") f.manager.releaseSyncSubagentConcurrency("test/one")
        f.controller.abort()
        return result
      })
      // when
      expect(await bounded(f.run())).toContain("sync_admission_cancelled")
      if (race !== "grant") f.manager.releaseSyncSubagentConcurrency("test/one")
      await bounded(acquire("test/one", "probe"))
      // then
      expect(f.create).not.toHaveBeenCalled()
      expect(releases).toHaveBeenCalledTimes(race === "grant" ? 2 : 1)
      const next = acquire("test/one", "next").then(() => "granted", () => "cancelled")
      expect(f.manager.cancelSyncSubagentConcurrencyWaiter("test/one", "next")).toBe(true)
      expect(await bounded(next)).toBe("cancelled")
      f.manager.releaseSyncSubagentConcurrency("test/one")
      await bounded(acquire("test/one", "recovery"))
      f.manager.releaseSyncSubagentConcurrency("test/one")
    })
  }

  test("ordinary admitted failure releases capacity and rolls back its spawn reservation", async () => {
    // given
    const f = fixture()
    const releases = spyOn(f.manager, "releaseSyncSubagentConcurrency")
    // when
    expect(await bounded(f.run())).toBe("fixture_session_rejected")
    // then
    expect(f.create).toHaveBeenCalledTimes(1)
    expect(releases).toHaveBeenCalledTimes(1)
    await bounded(f.manager.acquireSyncSubagentConcurrency("test/one", "probe"))
    f.manager.releaseSyncSubagentConcurrency("test/one")
  })

  test("cancellation during session creation returns promptly and aborts the late child without prompting", async () => {
    // given
    const f = fixture()
    const creating = Promise.withResolvers<void>()
    const created = Promise.withResolvers<Awaited<ReturnType<SyncTaskDeps["createSyncSession"]>>>()
    f.create.mockImplementation(() => { creating.resolve(); return created.promise })
    const releases = spyOn(f.manager, "releaseSyncSubagentConcurrency")
    const result = f.run()
    await bounded(creating.promise)
    // when
    f.controller.abort()
    expect(await bounded(result)).toContain("sync_admission_cancelled")
    created.resolve({ ok: true, sessionID: "late-child", parentDirectory: process.cwd() })
    await bounded(f.aborted.promise)
    // then
    expect(f.send).not.toHaveBeenCalled()
    expect(f.abort).toHaveBeenCalledTimes(1)
    expect(releases).toHaveBeenCalledTimes(1)
    await bounded(f.manager.acquireSyncSubagentConcurrency("test/one", "probe"))
    f.manager.releaseSyncSubagentConcurrency("test/one")
  })

  for (const providerLimit of [false, true]) {
    test(`queued abort removes only its waiter (provider limit: ${providerLimit})`, async () => {
      // given: an unrelated native holder occupies the actual concurrency owner
      const f = fixture(providerLimit)
      const holderModel = providerLimit ? "test/other" : "test/one"
      await f.manager.acquireSyncSubagentConcurrency(holderModel, "holder")
      const queued = Promise.withResolvers<void>()
      const acquire = f.manager.acquireSyncSubagentConcurrency.bind(f.manager)
      spyOn(f.manager, "acquireSyncSubagentConcurrency").mockImplementation((model, id) => {
        const result = acquire(model, id)
        queued.resolve()
        return result
      })
      const result = f.run()
      await queued.promise
      let unrelatedGranted = false
      const unrelated = acquire("test/one", "unrelated").then(() => { unrelatedGranted = true })
      // when
      f.controller.abort()
      try {
        expect(await bounded(result)).toContain("sync_admission_cancelled")
        expect(f.create).not.toHaveBeenCalled()
        expect(f.send).not.toHaveBeenCalled()
        expect(unrelatedGranted).toBe(false)
      } finally { f.manager.releaseSyncSubagentConcurrency(holderModel) }
      // then: release hands capacity to the unrelated waiter, not a retained cancelled child
      await bounded(unrelated)
      await result
      expect(f.create).not.toHaveBeenCalled()
      f.manager.releaseSyncSubagentConcurrency("test/one")
    })
  }
})
