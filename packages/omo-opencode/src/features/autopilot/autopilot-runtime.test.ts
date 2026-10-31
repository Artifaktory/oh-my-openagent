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

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture(nativeChronology = false) {
  const root = mkdtempSync(join(tmpdir(), "ap-producer-")); roots.push(root)
  const project = join(root, "project"), configPath = join(root, ".omo", "omo.jsonc")
  for (const dir of [join(root, ".omo"), ...["policy", "tasks", "evidence"].map(name => join(project, name))]) mkdirSync(dir, { recursive: true })
  const source = { id: "review", channel: "rule", kind: "file", source: join(project, "policy", "rule.md") }
  const writeConfig = (model = "test/one", mode = "on", extra: Record<string, unknown> = {}) => writeFileSync(configPath, JSON.stringify({
    "[opencode]": { autopilot: { format_version: "1", mode, enrollments: [{ id: "workspace", workspace: project,
      task_store_roots: ["tasks"], policy_roots: ["policy"], evidence_roots: ["evidence"], manifest: "policy/manifest.json", sources: [source] }] },
    agents: { autopilot: { model, fallback_models: ["test/two"], ...extra } } },
  }))
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
  const client = { app: { agents: async () => ({ data: [{ name: "Autopilot", mode: "subagent" }] }) },
    config: { get: async () => ({ data: { model: "test/one" } }) }, session: {
    get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, directory: project, ...(path.id === "parent" ? {} : { parentID: "parent" }) } }),
    create: async (input: Record<string, unknown>) => { creations.push(input); return { data: { id: `ses_${randomUUID()}` } } },
    abort: async ({ path }: { path: { id: string } }) => { aborted.push(path.id); return { data: true } },
    delete: async () => ({ data: true }), status: async () => ({ data: {} }),
    messages: async ({ path }: { path: { id: string } }) => ({ data: records.get(path.id) ?? [] }),
    promptAsync: async ({ path, body }: { path: { id: string }; body: Record<string, unknown> }) => {
      prompts.push({ sessionID: path.id, body })
      const model = body.model as { providerID: string; modelID: string }
      expect(body.agent).toBe("Autopilot")
      const info = { id: body.messageID, sessionID: path.id, role: "user", agent: String(body.agent), model }
      const parts = body.parts as { type: string; text: string }[]
      await hooks["chat.message"]({ sessionID: path.id, agent: "autopilot", model, messageID: String(body.messageID) } as never, { message: info, parts } as never)
      await hooks["chat.params"]({ sessionID: path.id, agent: { name: "autopilot" }, model, provider: { id: "test" }, message: info } as never, { options: {} })
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
  runtime = createAutopilotRuntime({ executor, environment: { HOME: root, USERPROFILE: root },
    readModels: async () => ({ availableModels: new Set(["test/one", "test/two"]), systemDefaultModel: "test/one" }),
    nativeDeps: { ...syncTaskDeps, pollSyncSession: async (_context, _client, input) => {
      if (pollFailures-- > 0) return "429 rate limit"
      if (nativeChronology && !isSessionComplete((records.get(input.sessionID) ?? []) as SessionMessage[])) {
        return "Native chronology rejected completed child"
      }
      return null
    } } })
  const plugin = createPluginInterface({ ctx: { client, directory: project }, pluginConfig: {}, hooks: {}, tools: {}, managers: {},
    firstMessageVariantGate: {} , autopilotRuntime: runtime } as unknown as Parameters<typeof createPluginInterface>[0])
  const chat = plugin["chat.message"], params = plugin["chat.params"], system = plugin["experimental.chat.system.transform"]
  const messages = plugin["experimental.chat.messages.transform"], tool = plugin["tool.execute.before"]
  if (!chat || !params || !system || !messages || !tool) throw Error("mandatory Autopilot hooks missing")
  hooks = { "chat.message": chat, "chat.params": params, "experimental.chat.system.transform": system,
    "experimental.chat.messages.transform": messages, "tool.execute.before": tool }
  return { runtime, hooks, context, controller, payload, publish, writeConfig, project, taskPath, prompts, creations, aborted, leases, released, records,
    setBeforeFinal(value: typeof beforeFinal) { beforeFinal = value }, setMalformed() { malformed = true },
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
