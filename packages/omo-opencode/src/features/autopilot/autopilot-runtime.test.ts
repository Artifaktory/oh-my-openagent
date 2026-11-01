import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import * as crypto from "node:crypto"
import { createAutopilotRuntime, type AutopilotRuntime } from "./autopilot-runtime"
import { sha256 } from "./protocol"
import { createPluginInterface } from "../../plugin-interface"
import { syncTaskDeps } from "../../tools/delegate-task/sync-task-deps"
import type { ExecutorContext, SessionMessage } from "../../tools/delegate-task/executor-types"
import { isSessionComplete } from "../../tools/delegate-task/sync-session-turns"
import type { ToolContextWithMetadata } from "../../tools/delegate-task/types"
import { stripInternalInitiatorMarkers } from "../../shared/internal-initiator-marker"
import { refreshAutopilotNativeConfig } from "./native-config"
import * as childRegistries from "./child-registry"
import type { OwnedAutopilotChild } from "./child-registry"
import { interceptAutopilotTask } from "../../tools/delegate-task/autopilot-task"
import { buildSyncPromptTools } from "../../tools/delegate-task/sync-prompt-sender"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture(nativeChronology = false) {
  const root = mkdtempSync(join(tmpdir(), "ap-producer-")); roots.push(root)
  const project = join(root, "project"), configPath = join(root, ".omo", "omo.jsonc")
  for (const dir of [join(root, ".omo"), ...["policy", "tasks", "evidence"].map(name => join(project, name))]) mkdirSync(dir, { recursive: true })
  const source = { id: "review", channel: "rule", kind: "file", source: join(project, "policy", "rule.md") }
  const writeConfig = (model = "test/one", mode = "on", extra: Record<string, unknown> = {},
    control: Record<string, unknown> = {}, categories?: Record<string, unknown>) => writeFileSync(configPath, JSON.stringify({
    "[opencode]": { autopilot: { format_version: "1", mode, ...control, enrollments: [{ id: "workspace", workspace: project,
      task_store_roots: ["tasks"], policy_roots: ["policy"], evidence_roots: ["evidence"], manifest: "policy/manifest.json", sources: [source] }] },
    agents: { autopilot: { model, fallback_models: ["test/two"], ...extra } }, ...(categories ? { categories } : {}) },
  }))
  const writeProjectLimit = (timeout_ms: number) => {
    mkdirSync(join(project, ".omo"), { recursive: true })
    writeFileSync(join(project, ".omo", "omo.jsonc"), JSON.stringify({
      "[opencode]": { autopilot: { format_version: "1", limits: { timeout_ms } } },
    }))
  }
  const publish = (text: string, revision = text) => {
    writeFileSync(source.source, text)
    writeFileSync(join(project, "policy", "manifest.json"), JSON.stringify({ format_version: "1", revision, sources: [{ ...source, sha256: sha256(text) }] }))
  }
  writeConfig(); publish("rule-A")
  const taskPath = join(project, "tasks", "task1.json")
  writeFileSync(taskPath, JSON.stringify({ id: "task1", subject: "bounded task", description: "fixture", status: "in_progress", threadID: "parent", blocks: [], blockedBy: [] }))
  writeFileSync(join(project, "evidence", "subject.md"), "exact subject")
  writeFileSync(join(project, "evidence", "check.json"), JSON.stringify({ exit: 0, subject: sha256("exact subject") }))
  const payload = JSON.stringify({ protocol: "autopilot.assessment.v1", task: { store: "tasks", id: "task1" },
    subject: { path: "evidence/subject.md" }, evidence: [{ id: "check", path: "evidence/check.json" }] })
  const controller = new AbortController()
  const context: ToolContextWithMetadata = { sessionID: "parent", messageID: "parent-message", callID: "call", agent: "sisyphus", abort: controller.signal }
  const records = new Map<string, unknown[]>()
  const prompts: { sessionID: string; body: Record<string, unknown> }[] = []
  const creations: Record<string, unknown>[] = [], aborted: string[] = [], leases: string[] = [], released: string[] = []
  const occupied = new Set<string>()
  let runtime: AutopilotRuntime
  let hooks: Required<Pick<ReturnType<typeof createPluginInterface>, "chat.message" | "chat.params"
    | "experimental.chat.system.transform" | "experimental.chat.messages.transform" | "tool.execute.before">>
  let beforeFinal: (() => Promise<void>) | undefined
  let malformed = false, pollFailures = 0, omitBoundary = false
  let nativeName = "Autopilot"
  let availableModels = new Set(["test/one", "test/two"])
  const defaultReadModels = async () => ({ availableModels, systemDefaultModel: "test/one" })
  let readModels: NonNullable<Parameters<typeof createAutopilotRuntime>[0]["readModels"]> = defaultReadModels
  const client = { app: { agents: async () => ({ data: [{ name: nativeName, mode: "subagent" }] }) },
    config: { get: async () => ({ data: { model: "test/one" } }) }, session: {
    get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, directory: project, ...(path.id === "parent" ? {} : { parentID: "parent" }) } }),
    create: async (input: Record<string, unknown>) => { creations.push(input); return { data: { id: `ses_${randomUUID()}` } } },
    abort: async ({ path }: { path: { id: string } }) => { aborted.push(path.id); return { data: true } },
    delete: async () => ({ data: true }), status: async () => ({ data: {} }),
    messages: async ({ path }: { path: { id: string } }) => ({ data: records.get(path.id) ?? [] }),
    promptAsync: async ({ path, body }: { path: { id: string }; body: Record<string, unknown> }) => {
      prompts.push({ sessionID: path.id, body })
      const model = body.model as { providerID: string; modelID: string }
      expect(body.agent).toBe(nativeName)
      const info = { id: body.messageID, sessionID: path.id, role: "user", agent: String(body.agent), model }
      const parts = body.parts as { type: string; text: string }[]
      await hooks["chat.message"]({ sessionID: path.id, agent: "autopilot", model, messageID: String(body.messageID) } as never, { message: info, parts } as never)
      await hooks["chat.params"]({ sessionID: path.id, agent: { name: "autopilot" }, model, provider: { id: model.providerID }, message: info } as never, { options: {} })
      const system = { system: ["ambient stale rules"] }
      await hooks["experimental.chat.system.transform"]({ sessionID: path.id, model: { providerID: model.providerID, id: model.modelID } } as never, system)
      expect(system.system).toEqual([body.system as string])
      const transcript = { messages: [{ info, parts }] }
      if (!omitBoundary) await hooks["experimental.chat.messages.transform"]({}, transcript as never)
      records.set(path.id, transcript.messages)
      if (beforeFinal) await beforeFinal()
      const request = JSON.parse(stripInternalInitiatorMarkers(parts[0].text)) as { request: { invocation_id: string; evidence: { id: string }[] }; request_digest: string }
      const decision = { protocol: "autopilot.model-decision.v1", invocation_id: request.request.invocation_id,
        request_digest: request.request_digest, outcome: "approve", reason_codes: ["evidence_checked"],
        evidence_ids: request.request.evidence.map(item => item.id), explanation: "Controlled provider fixture" }
      records.set(path.id, [...transcript.messages, { info: { id: nativeChronology ? "msg_18e94f223001HAKWZaTSc1mwIB" : `msg_${randomUUID()}`, sessionID: path.id,
        parentID: body.messageID, role: "assistant", agent: String(body.agent), providerID: model.providerID, modelID: model.modelID,
        finish: "stop", time: { created: Date.now(), completed: Date.now() } },
        parts: [{ type: malformed ? "reasoning" : "text", text: JSON.stringify(decision) }] }])
      return { data: undefined }
    },
  } }
  const manager = {
    acquireSyncSubagentConcurrency: async (key: string) => { if (occupied.has(key)) throw Error("duplicate lease"); occupied.add(key); leases.push(key) },
    releaseSyncSubagentConcurrency: (key: string) => { if (!occupied.delete(key)) throw Error("double release"); released.push(key) },
    cancelSyncSubagentConcurrencyWaiter: () => false,
    reserveSubagentSpawn: async () => ({ commit: () => {}, rollback: () => {}, spawnContext: { rootSessionID: "parent", parentDepth: 0, childDepth: 1 } }),
  }
  const executor = { client, directory: project, manager, taskCleanupDelayMs: 0 } as unknown as ExecutorContext
  const environment = { HOME: root, USERPROFILE: root }
  const makeRuntime = () => createAutopilotRuntime({ executor, environment, nativeAgentNames: [nativeName],
    readModels: () => readModels(),
    nativeDeps: { ...syncTaskDeps, pollSyncSession: async (_context, _client, input) => {
      if (pollFailures-- > 0) return "429 rate limit"
      if (nativeChronology && !isSessionComplete((records.get(input.sessionID) ?? []) as SessionMessage[])) {
        return "Native chronology rejected completed child"
      }
      return null
    } } })
  runtime = makeRuntime()
  const plugin = createPluginInterface({ ctx: { client, directory: project }, pluginConfig: {}, hooks: {}, tools: {}, managers: {},
    firstMessageVariantGate: {} , autopilotRuntime: runtime } as unknown as Parameters<typeof createPluginInterface>[0])
  const chat = plugin["chat.message"], params = plugin["chat.params"], system = plugin["experimental.chat.system.transform"]
  const messages = plugin["experimental.chat.messages.transform"], tool = plugin["tool.execute.before"]
  if (!chat || !params || !system || !messages || !tool) throw Error("mandatory Autopilot hooks missing")
  hooks = { "chat.message": chat, "chat.params": params, "experimental.chat.system.transform": system,
    "experimental.chat.messages.transform": messages, "tool.execute.before": tool }
  return { runtime, hooks, client, executor, environment, makeRuntime, context, controller, payload, publish, writeConfig, writeProjectLimit,
    project, taskPath, prompts, creations, aborted, leases, released, records,
    setBeforeFinal(value: typeof beforeFinal) { beforeFinal = value }, setMalformed() { malformed = true },
    setReadModels(value?: typeof readModels) { readModels = value ?? defaultReadModels },
    setAvailableModels(value: Set<string>) { availableModels = value },
    setNativeName(value: string) { nativeName = value },
    setPollFailure() { pollFailures = 1 }, omitBoundary() { omitBoundary = true } }
}

describe("operational Autopilot producer", () => {
  test("#given fixture04 native chronology #when a bound child completes #then native completion produces its private receipt", async () => {
    const clock = spyOn(Date, "now").mockReturnValue(1793393488419)
    const uuid = spyOn(crypto, "randomUUID").mockReturnValue("3be320ce-12ef-49b7-9bfd-17be8e7dc34a")
    try {
      const f = fixture(true)
      const result = await f.runtime.invoke(f.payload, f.context)
      expect(result).toMatchObject({ ok: true })
      if (!result.ok) throw Error(result.error)
      expect(f.runtime.isReceipt(result.receipt)).toBe(true)
      expect(result.receipt.provenance.final_message_id).toBe("msg_18e94f223001HAKWZaTSc1mwIB")
      expect(f.released).toEqual(f.leases)
    } finally {
      uuid.mockRestore()
      clock.mockRestore()
    }
  })

  test("#given enrolled host facts #when native task completes #then genuine private receipt has actual provenance and no store effect", async () => {
    const f = fixture(), before = readFileSync(f.taskPath, "utf8")
    const result = await f.runtime.invoke(f.payload, f.context)
    expect(result).toMatchObject({ ok: true })
    if (!result.ok) return
    expect(f.runtime.isReceipt(result.receipt)).toBe(true)
    expect(f.runtime.isReceipt(JSON.parse(JSON.stringify(result.receipt)))).toBe(false)
    expect(fixture().runtime.isReceipt(result.receipt)).toBe(false)
    expect(result.receipt.provenance).toMatchObject({ child_session_id: f.prompts[0].sessionID, agent: "autopilot", model_id: "one", fallback_attempt: 0 })
    expect(result.receipt.scope.task.id).toBe("task1")
    expect(result.receipt.scope.host.parent_session_id).toBe("parent")
    expect(result.receipt.scope.subject.digest).toBe(sha256("exact subject"))
    expect(result.receipt.scope.evidence.find(item => item.id === "check")).toMatchObject({ sha256: sha256(readFileSync(join(f.project, "evidence", "check.json"))) })
    expect(result.receipt.scope.evidence.every(item => !Object.hasOwn(item, "content"))).toBe(true)
    expect(result.receipt.effect).toEqual({ task_store_commit: "not_attempted", todo_projection: "not_attempted" })
    expect(readFileSync(f.taskPath, "utf8")).toBe(before)
    expect(f.released).toEqual(f.leases)
    await expect(f.runtime.guardSession(f.prompts[0].sessionID, "autopilot")).rejects.toThrow()
    f.runtime.dispose()
  })

  test("#given in-flight A #when policy and model change then revert #then each fresh child receives one captured snapshot", async () => {
    const f = fixture(), entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>()
    f.setBeforeFinal(async () => { entered.resolve(); await resume.promise })
    const first = f.runtime.invoke(f.payload, f.context)
    await Promise.race([entered.promise, first.then(result => { if (!result.ok) throw Error(result.error) })])
    f.publish("rule-B"); f.writeConfig("test/two"); f.context.sessionID = "caller-mutated"
    resume.resolve(); expect((await first).ok).toBe(true)
    f.context.sessionID = "parent"; f.setBeforeFinal(undefined)
    const second = await f.runtime.invoke(f.payload, f.context)
    f.publish("rule-A", "revert-A"); f.writeConfig()
    const third = await f.runtime.invoke(f.payload, f.context)
    expect(second.ok).toBe(true); expect(third.ok).toBe(true)
    expect(f.prompts[0].body.system).toContain("rule-A")
    expect(f.prompts[1].body.system).toContain("rule-B")
    expect(f.prompts[2].body.system).toContain("rule-A")
    expect(new Set(f.prompts.map(item => item.sessionID)).size).toBe(3)
    expect(f.leases).toEqual(["test/one", "test/two", "test/one"])
  })

  for (const failure of ["revocation", "cancel", "malformed", "missing-boundary"] as const) {
    test(`#given an owned child #when ${failure} occurs #then no receipt escapes`, async () => {
      const f = fixture()
      if (failure === "malformed") f.setMalformed()
      if (failure === "missing-boundary") f.omitBoundary()
      f.setBeforeFinal(async () => { if (failure === "revocation") f.writeConfig("test/one", "off"); if (failure === "cancel") f.controller.abort() })
      const result = await f.runtime.invoke(f.payload, f.context)
      expect(result.ok).toBe(false); expect(f.runtime.isReceipt(result)).toBe(false)
      expect(f.prompts).toHaveLength(1)
      expect(f.released).toEqual(f.leases)
    })
  }

  test("#given retryable native failure #when captured fallback runs #then new child and actual model leases are used once", async () => {
    const f = fixture(); f.setPollFailure()
    const result = await f.runtime.invoke(f.payload, f.context)
    expect(result).toMatchObject({ ok: true })
    expect(f.prompts).toHaveLength(2)
    expect(f.prompts[0].sessionID).not.toBe(f.prompts[1].sessionID)
    expect(f.leases).toEqual(["test/one", "test/two"]); expect(f.released).toEqual(f.leases)
    expect(f.aborted).toContain(f.prompts[0].sessionID)
    if (result.ok) expect(result.receipt.provenance).toMatchObject({ model_id: "two", fallback_attempt: 1 })
  })

  test.each(["direct", "category"] as const)("R1-dispatch-%s #given an explicit primary without declared fallback #when its native attempt fails retryably #then no second child is dispatched", async selection => {
    const f = fixture()
    f.setAvailableModels(new Set(["test/one", "openai/gpt-6-astra"]))
    f.writeConfig("test/one", "on", { fallback_models: undefined,
      ...(selection === "category" ? { model: undefined, category: "review" } : {}) }, {}, { review: { model: "test/one" } })
    f.setPollFailure()
    try {
      const result = await f.runtime.invoke(f.payload, f.context)
      expect(f.prompts.map(prompt => prompt.body.model)).toEqual([{ providerID: "test", modelID: "one" }])
      expect(f.creations).toHaveLength(1)
      expect(f.leases).toEqual(["test/one"])
      expect(f.released).toEqual(f.leases)
      expect(result).toMatchObject({ ok: false, outcome: "human_required", error: "native_result_invalid" })
      expect(f.runtime.isReceipt(result)).toBe(false)
    } finally { f.controller.abort(); f.runtime.dispose() }
  })

  test.each(["user", "project"] as const)("R2-discovery-%s #given a tightened total deadline #when initial model lookup is latched #then expire before release and never dispatch late", async source => {
    const f = fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const returned = Promise.withResolvers<void>()
    f.writeConfig("test/one", "on", {}, { limits: { timeout_ms: source === "user" ? 100 : 10000 } })
    if (source === "project") f.writeProjectLimit(100)
    const discovery = { availableModels: new Set(["test/one", "test/two"]), systemDefaultModel: "test/one" }
    const projection = refreshAutopilotNativeConfig(f.project, discovery, f.environment)
    expect(projection.binding.state).toBe("enabled")
    expect(projection.binding.limits.timeout_ms).toBe(100)
    f.setReadModels(async () => {
      entered.resolve()
      await release.promise
      returned.resolve()
      return discovery
    })
    let watchdog: ReturnType<typeof setTimeout> | undefined
    const bounded = new Promise<never>((_resolve, reject) => {
      watchdog = setTimeout(() => reject(Error("R2 initial model discovery exceeded the 1000ms observation bound for a 100ms deadline")), 1000)
    })
    const pending = f.runtime.invoke(f.payload, f.context)
    try {
      await Promise.race([entered.promise, bounded, pending.then(() => { throw Error("R2 invocation settled without entering initial model discovery") })])
      const result = await Promise.race([pending, bounded])
      expect(result).toEqual({ ok: false, outcome: "human_required", error: "request_expired" })
      expect(f.runtime.isReceipt(result)).toBe(false)
      expect(f.creations).toHaveLength(0)
      expect(f.prompts).toHaveLength(0)
      expect(f.leases).toHaveLength(0)
      release.resolve()
      await returned.promise
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(f.creations).toHaveLength(0)
      expect(f.prompts).toHaveLength(0)
      expect(f.released).toHaveLength(0)
      if (watchdog) clearTimeout(watchdog)
      f.setReadModels()
      f.writeConfig()
      if (source === "project") f.writeProjectLimit(10000)
      const recovery = await f.runtime.invoke(f.payload, f.context)
      expect(recovery.ok).toBe(true)
      expect(f.prompts).toHaveLength(1)
      expect(f.released).toEqual(f.leases)
    } finally {
      if (watchdog) clearTimeout(watchdog)
      f.controller.abort()
      release.resolve()
      await pending
      f.runtime.dispose()
    }
  })

  test("R3-obsolete-producer #given restart and an obsolete native display name #when a retained private request is found #then it denies reuse without granting ownership", async () => {
    const f = fixture(), oldName = "old-review-name"
    f.setNativeName(oldName)
    f.writeConfig("test/one", "on", { displayName: oldName })
    let restarted: AutopilotRuntime | undefined
    try {
      const produced = await f.runtime.invoke(f.payload, f.context)
      expect(produced.ok).toBe(true)
      if (!produced.ok) throw Error(produced.error)
      const childID = produced.receipt.provenance.child_session_id
      const history = f.records.get(childID) as { info: { role: string; agent: string; system?: string; tools?: Record<string, boolean> }; parts: unknown[] }[]
      expect(history.map(message => message.info.agent)).toEqual([oldName, oldName])
      expect(history[0].info.system).toBe(f.prompts[0].body.system as string)
      expect(history[0].info.tools).toEqual({ "*": false })
      expect(f.runtime.isReceipt(produced.receipt)).toBe(true)
      f.runtime.dispose()
      f.setNativeName("New Gate")
      f.writeConfig("test/one", "on", { displayName: "New Gate" })
      restarted = f.makeRuntime()
      expect(restarted.ownsChild(childID)).toBe(false)
      expect(restarted.isAutopilotName(oldName)).toBe(false)
      expect(restarted.isReceipt(produced.receipt)).toBe(false)
      for (const autopilotRuntime of [undefined, restarted]) {
        for (const args of [{ task_id: childID }, { task_id: childID, subagent_type: "explore", run_in_background: true }]) {
          const result = await interceptAutopilotTask(args, f.context, { client: f.client as never, autopilotRuntime })
          expect(result).toContain("child_reuse")
          expect(JSON.parse(result ?? "null")).toMatchObject({ outcome: "human_required", error: "child_reuse", effect: "not_attempted" })
        }
      }
      await expect(restarted.guardSession(childID)).rejects.toThrow("unowned_child")
      expect(() => restarted?.messages({ messages: structuredClone(history) })).toThrow("unowned_child")
      const ordinaryID = "ses_ordinary_request_data"
      const ordinary = { messages: [{ info: { id: "msg_ordinary_data", sessionID: ordinaryID, role: "user", agent: oldName,
        model: { providerID: "test", modelID: "one" }, system: "Ordinary task fixture", tools: buildSyncPromptTools(oldName) },
        parts: structuredClone(history[0].parts) }] }
      f.records.set(ordinaryID, ordinary.messages)
      const before = structuredClone(ordinary)
      expect(await interceptAutopilotTask({ task_id: ordinaryID }, f.context,
        { client: f.client as never, autopilotRuntime: restarted })).toBeUndefined()
      expect(restarted.messages(ordinary)).toBe(false)
      expect(ordinary).toEqual(before)
      expect(restarted.ownsChild(ordinaryID)).toBe(false)
      expect(f.prompts).toHaveLength(1)
    } finally { restarted?.dispose(); f.controller.abort(); f.runtime.dispose() }
  })

  test.each(["success", "fallback", "cancel", "child-deleted", "child-error", "parent-deleted", "dispose"] as const)(
    "R4-release-%s #given a producer-owned payload #when its terminal path runs #then lookup releases it while old identity stays denied", async terminal => {
      const registry = childRegistries.createAutopilotChildRegistry()
      const factory = spyOn(childRegistries, "createAutopilotChildRegistry").mockReturnValue(registry)
      let f: ReturnType<typeof fixture>
      try { f = fixture() } finally { factory.mockRestore() }
      const captured = new Map<string, OwnedAutopilotChild>()
      if (terminal === "fallback") f.setPollFailure()
      f.setBeforeFinal(async () => {
        const sessionID = f.prompts[f.prompts.length - 1].sessionID
        const child = registry.get(sessionID)
        expect(child).toBeDefined()
        if (!child) throw Error("R4 producer did not register the dispatched child")
        captured.set(sessionID, child)
        if (terminal === "cancel") f.controller.abort()
        if (terminal === "child-deleted") f.runtime.event({ type: "session.deleted", properties: { info: { id: sessionID } } })
        if (terminal === "child-error") f.runtime.event({ type: "session.error", properties: { sessionID } })
        if (terminal === "parent-deleted") f.runtime.event({ type: "session.deleted", properties: { info: { id: "parent" } } })
        if (terminal === "dispose") f.runtime.dispose()
      })
      try {
        const result = await f.runtime.invoke(f.payload, f.context)
        expect(result.ok).toBe(terminal === "success" || terminal === "fallback")
        expect(captured.size).toBe(terminal === "fallback" ? 2 : 1)
        expect(f.released).toEqual(f.leases)
        for (const [sessionID, child] of captured) {
          expect(registry.has(sessionID)).toBe(true)
          expect(() => registry.require(sessionID)).toThrow("request_cancelled")
          expect(() => registry.require(sessionID, "explore")).toThrow("request_cancelled")
          expect(() => registry.register(child)).toThrow("child_reuse")
          await expect(f.runtime.guardSession(sessionID, "explore")).rejects.toThrow("request_cancelled")
          await expect(registry.tool(sessionID, "read", {})).rejects.toThrow("request_cancelled")
          expect(() => registry.messages({ messages: [{ info: { sessionID, role: "user", agent: "explore" }, parts: [] }] })).toThrow("request_cancelled")
          expect(await interceptAutopilotTask({ task_id: sessionID }, f.context,
            { client: f.client as never, autopilotRuntime: f.runtime })).toContain("child_reuse")
          expect(registry.get(sessionID)).toBeUndefined()
          registry.stop(sessionID)
          registry.stopAll()
          expect(registry.get(sessionID)).toBeUndefined()
          expect(() => registry.register(child)).toThrow("child_reuse")
        }
        if (terminal !== "dispose") {
          f.setBeforeFinal(undefined)
          const recovery = await f.runtime.invoke(f.payload, { ...f.context, abort: new AbortController().signal })
          expect(recovery.ok).toBe(true)
          expect(captured.has(f.prompts[f.prompts.length - 1].sessionID)).toBe(false)
          expect(registry.get(f.prompts[f.prompts.length - 1].sessionID)).toBeUndefined()
          expect(f.released).toEqual(f.leases)
        } else {
          expect(await f.runtime.invoke(f.payload, f.context)).toMatchObject({ ok: false, error: "runtime_unavailable" })
        }
      } finally { f.controller.abort(); f.runtime.dispose() }
    })

  test("#given caller attestation or absent lineage #when invoked #then no child is created", async () => {
    const f = fixture()
    expect((await f.runtime.invoke(JSON.stringify({ ...JSON.parse(f.payload), verified: true }), f.context)).ok).toBe(false)
    f.context.sessionID = "unrelated" // this synthetic session is a child of parent, so sever the stored task origin
    const task = JSON.parse(readFileSync(f.taskPath, "utf8")); task.threadID = "foreign"
    writeFileSync(f.taskPath, JSON.stringify(task))
    expect((await f.runtime.invoke(f.payload, f.context)).ok).toBe(false)
    expect(f.creations).toHaveLength(0)
  })

  test("#given owned tool defaults #when a tool is attempted #then optional hooks cannot grant access", async () => {
    const f = fixture()
    let checked = false
    f.setBeforeFinal(async () => {
      await expect(f.hooks["tool.execute.before"]({ sessionID: f.prompts[0].sessionID, tool: "read", callID: "tool" },
        { args: { filePath: join(f.project, "evidence", "subject.md") } })).rejects.toThrow("tool_forbidden")
      checked = true
    })
    expect((await f.runtime.invoke(f.payload, f.context)).ok).toBe(true)
    expect(checked).toBe(true)
  })

  test("#given enrolled read permission #when tools cross roots or request a write #then mandatory guards reject widening", async () => {
    const f = fixture(); f.writeConfig("test/one", "on", { tools: { read: true } })
    let checked = false
    f.setBeforeFinal(async () => {
      const sessionID = f.prompts[0].sessionID
      const permitted = { args: { filePath: "evidence/subject.md" } }
      await f.hooks["tool.execute.before"]({ sessionID, tool: "read", callID: "read" }, permitted)
      expect(permitted.args.filePath).toBe(join(f.project, "evidence", "subject.md"))
      await expect(f.hooks["tool.execute.before"]({ sessionID, tool: "read", callID: "outside" }, { args: { filePath: f.taskPath } })).rejects.toThrow("source_forbidden")
      await expect(f.hooks["tool.execute.before"]({ sessionID, tool: "read", callID: "secret" }, { args: { filePath: "evidence/.env" } })).rejects.toThrow("source_forbidden")
      await expect(f.hooks["tool.execute.before"]({ sessionID, tool: "bash", callID: "write" }, { args: { command: "echo" } })).rejects.toThrow("tool_forbidden")
      checked = true
    })
    expect((await f.runtime.invoke(f.payload, f.context)).ok).toBe(true)
    expect(checked).toBe(true)
    expect((f.creations[0].body as { permission: unknown[] }).permission).toContainEqual({ permission: "*", pattern: "*", action: "deny" })
  })

  test("#given parent lifecycle termination #when received during dispatch #then child receipt is cancelled", async () => {
    const f = fixture()
    f.setBeforeFinal(async () => { f.runtime.event({ type: "session.deleted", properties: { info: { id: "parent" } } }) })
    expect(await f.runtime.invoke(f.payload, f.context)).toMatchObject({ ok: false, error: "request_cancelled" })
    expect(f.prompts).toHaveLength(1)
  })
})
