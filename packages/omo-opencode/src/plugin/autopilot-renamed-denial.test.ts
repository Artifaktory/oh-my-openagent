import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { createPluginInterface } from "../plugin-interface"
import { createAutopilotRuntime } from "../features/autopilot/autopilot-runtime"
import { AutopilotError } from "../features/autopilot/types"
import { sha256 } from "../features/autopilot/protocol"
import { stripInternalInitiatorMarkers } from "../shared/internal-initiator-marker"
import { syncTaskDeps } from "../tools/delegate-task/sync-task-deps"
import { buildSyncPromptTools } from "../tools/delegate-task/sync-prompt-sender"
import type { ExecutorContext } from "../tools/delegate-task/executor-types"

const formerName = "old-review-name"
type History = { info: { id: string; sessionID: string; role: string; agent: string;
  model?: { providerID: string; modelID: string }; system?: string; tools?: Record<string, boolean> };
  parts: { type: string; text: string }[] }[]

async function produceHistory(root: string) {
  const project = join(root, "project")
  for (const dir of [join(root, ".omo"), ...["policy", "tasks", "evidence"].map(name => join(project, name))]) {
    mkdirSync(dir, { recursive: true })
  }
  const source = { id: "review", channel: "rule", kind: "file", source: join(project, "policy", "rule.md") }
  writeFileSync(source.source, "Review the exact evidence")
  writeFileSync(join(project, "policy", "manifest.json"), JSON.stringify({ format_version: "1", revision: "one",
    sources: [{ ...source, sha256: sha256("Review the exact evidence") }] }))
  writeFileSync(join(root, ".omo", "omo.jsonc"), JSON.stringify({ "[opencode]": {
    autopilot: { format_version: "1", mode: "on", enrollments: [{ id: "workspace", workspace: project,
      task_store_roots: ["tasks"], policy_roots: ["policy"], evidence_roots: ["evidence"],
      manifest: "policy/manifest.json", sources: [source] }] },
    agents: { autopilot: { model: "test/one", displayName: formerName } },
  } }))
  writeFileSync(join(project, "tasks", "task1.json"), JSON.stringify({ id: "task1", subject: "bounded task",
    description: "fixture", status: "in_progress", threadID: "parent", blocks: [], blockedBy: [] }))
  writeFileSync(join(project, "evidence", "subject.md"), "exact subject")
  writeFileSync(join(project, "evidence", "check.json"), JSON.stringify({ exit: 0, subject: sha256("exact subject") }))
  const records = new Map<string, History>()
  let plugin: ReturnType<typeof createPluginInterface>
  let ownedGuard = false
  const client = { app: { agents: async () => ({ data: [{ name: formerName, mode: "subagent" }] }) },
    config: { get: async () => ({ data: { model: "test/one" } }) }, session: {
      get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, directory: project,
        ...(path.id === "parent" ? {} : { parentID: "parent" }) } }),
      create: async () => ({ data: { id: "ses_produced_former_child" } }),
      abort: async () => ({ data: true }), delete: async () => ({ data: true }), status: async () => ({ data: {} }),
      messages: async ({ path }: { path: { id: string } }) => ({ data: records.get(path.id) ?? [] }),
      promptAsync: async ({ path, body }: { path: { id: string }; body: Record<string, unknown> }) => {
        const model = body.model as { providerID: string; modelID: string }
        const info = { id: String(body.messageID), sessionID: path.id, role: "user", agent: String(body.agent), model }
        const parts = body.parts as History[number]["parts"]
        ownedGuard = await producer.guardSession(path.id, formerName)
        const chatMessage = plugin["chat.message"]
        if (typeof chatMessage !== "function") throw Error("producer fixture missing chat.message hook")
        await chatMessage({ sessionID: path.id, agent: formerName, model, messageID: info.id } as never,
          { message: info, parts } as never)
        const chatParams = plugin["chat.params"]
        if (typeof chatParams !== "function") throw Error("producer fixture missing chat.params hook")
        await chatParams({ sessionID: path.id, agent: { name: formerName }, model,
          provider: { id: model.providerID }, message: info } as never, { options: {} })
        const systemTransform = plugin["experimental.chat.system.transform"]
        if (typeof systemTransform !== "function") throw Error("producer fixture missing system transform hook")
        await systemTransform({ sessionID: path.id,
          model: { providerID: model.providerID, id: model.modelID } } as never, { system: [] })
        const transcript = { messages: [{ info, parts }] }
        const messagesTransform = plugin["experimental.chat.messages.transform"]
        if (typeof messagesTransform !== "function") throw Error("producer fixture missing messages transform hook")
        await messagesTransform({}, transcript as never)
        const envelope = JSON.parse(stripInternalInitiatorMarkers(parts[0].text))
        const decision = { protocol: "autopilot.model-decision.v1", invocation_id: envelope.request.invocation_id,
          request_digest: envelope.request_digest, outcome: "approve", reason_codes: ["evidence_checked"],
          evidence_ids: ["check"], explanation: "Controlled SDK response" }
        records.set(path.id, [...transcript.messages, { info: { id: "msg_fixture_final", sessionID: path.id,
          parentID: info.id, role: "assistant", agent: formerName, providerID: model.providerID, modelID: model.modelID,
          finish: "stop", time: { created: Date.now(), completed: Date.now() } },
          parts: [{ type: "text", text: JSON.stringify(decision) }] } as History[number]])
        return { data: undefined }
      },
    } }
  const manager = { acquireSyncSubagentConcurrency: async () => {}, releaseSyncSubagentConcurrency: () => {},
    cancelSyncSubagentConcurrencyWaiter: () => false,
    reserveSubagentSpawn: async () => ({ commit: () => {}, rollback: () => {},
      spawnContext: { rootSessionID: "parent", parentDepth: 0, childDepth: 1 } }) }
  const producer = createAutopilotRuntime({ executor: { client, directory: project, manager, taskCleanupDelayMs: 0 } as unknown as ExecutorContext,
    environment: { HOME: root, USERPROFILE: root }, nativeAgentNames: [formerName],
    readModels: async () => ({ availableModels: new Set(["test/one"]), systemDefaultModel: "test/one" }),
    nativeDeps: { ...syncTaskDeps, pollSyncSession: async () => null } })
  plugin = createPluginInterface({ ctx: { client, directory: project }, pluginConfig: {}, hooks: {}, tools: {}, managers: {},
    firstMessageVariantGate: {}, autopilotRuntime: producer } as unknown as Parameters<typeof createPluginInterface>[0])
  try {
    const result = await producer.invoke(JSON.stringify({ protocol: "autopilot.assessment.v1", task: { store: "tasks", id: "task1" },
      subject: { path: "evidence/subject.md" }, evidence: [{ id: "check", path: "evidence/check.json" }] }),
    { sessionID: "parent", messageID: "parent_message", callID: "call", agent: "sisyphus", abort: new AbortController().signal })
    if (!result.ok) throw Error(`producer fixture failed: ${result.error}`)
    expect(producer.isReceipt(result.receipt)).toBe(true)
    const childID = result.receipt.provenance.child_session_id
    await expect(producer.guardSession(childID, formerName)).rejects.toThrow("request_cancelled")
    const history = records.get(childID)
    if (history === undefined) throw Error("producer fixture missing child history")
    return { history: structuredClone(history), childID, ownedGuard }
  } finally { producer.dispose() }
}

function boundary(history: History, present: boolean) {
  let ordinaryCalls = 0
  const client = { session: { messages: async () => ({ data: structuredClone(history) }) },
    tui: { showToast: async () => ({ data: true }) } }
  const runtime = createAutopilotRuntime({ executor: { client, directory: process.cwd(), manager: {} } as unknown as ExecutorContext,
    nativeAgentNames: ["New Gate"] })
  const plugin = createPluginInterface({ ctx: { client, directory: process.cwd() },
    pluginConfig: { agents: { autopilot: { displayName: "New Gate" } } }, tools: {}, managers: {},
    firstMessageVariantGate: { shouldOverride: () => false, markApplied: () => {}, markSessionCreated: () => {}, clear: () => {} },
    hooks: { keywordDetector: { "chat.message": async (_input: unknown, output: { parts: { type: string; text: string }[] }) => {
      ordinaryCalls++; output.parts.push({ type: "text", text: "ordinary callback reached" })
    } } }, ...(present ? { autopilotRuntime: runtime } : {}) } as unknown as Parameters<typeof createPluginInterface>[0])
  const chat = plugin["chat.message"]
  if (typeof chat !== "function") throw Error("boundary fixture missing chat.message hook")
  return { runtime, chat, ordinaryCalls: () => ordinaryCalls }
}

async function rejection(action: () => Promise<unknown>) {
  try { await action(); return null }
  catch (error) { if (!(error instanceof AutopilotError)) throw error; return error.code }
}

describe("RESTART-DENIAL-01 early former-agent denial", () => {
  let root: string
  let produced: Awaited<ReturnType<typeof produceHistory>>
  beforeAll(async () => { root = mkdtempSync(join(process.cwd(), "renamed-denial-")); produced = await produceHistory(root) })
  afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }) })

  test("#given genuine producer history #when ownership ends #then its factory-owned dispatch and retained context remain usable controls", () => {
    expect(produced.ownedGuard).toBe(true)
    expect(produced.history.map(message => message.info.agent)).toEqual([formerName, formerName])
  })

  for (const agent of [undefined, formerName, { name: formerName }]) {
    test(`#given retained producer history #when guard receives ${JSON.stringify(agent)} #then reject unowned child`, async () => {
      const f = boundary(produced.history, true)
      try {
        expect(f.runtime.ownsChild(produced.childID)).toBe(false)
        expect(f.runtime.isAutopilotName(formerName)).toBe(false)
        expect(await rejection(() => f.runtime.guardSession(produced.childID, agent))).toBe("unowned_child")
      } finally { f.runtime.dispose() }
    })
  }

  for (const present of [true, false]) {
    for (const agent of [undefined, formerName, "New Gate", "autopilot"]) {
      test(`#given retained history runtime=${present} #when public chat selects ${agent} #then reject before ordinary callback or output change`, async () => {
        const f = boundary(produced.history, present)
        const output = { message: { id: "msg_direct", sessionID: produced.childID }, parts: [{ type: "text", text: "Resume review" }] }
        const before = structuredClone(output)
        try {
          const error = await rejection(() => f.chat({ sessionID: produced.childID, ...(agent ? { agent } : {}) } as never, output as never))
          expect({ error, ordinaryCalls: f.ordinaryCalls(), output }).toEqual({
            error: present ? "unowned_child" : "runtime_unavailable", ordinaryCalls: 0, output: before,
          })
        } finally { f.runtime.dispose() }
      })
    }

    for (const variant of ["copied-data", "missing-system", "malformed-payload", "invalid-digest", "wrong-model", "widened-tools"] as const) {
      test(`#given ordinary ${variant} runtime=${present} #when omitted and explicit aliases reach guards #then preserve ordinary chat`, async () => {
        const history = structuredClone(produced.history.slice(0, 1))
        history[0].info.sessionID = "ses_ordinary"
        if (variant === "copied-data") {
          history[0].info.system = "Ordinary task fixture"
          history[0].info.tools = buildSyncPromptTools(formerName)
        }
        if (variant === "missing-system") delete history[0].info.system
        if (variant === "malformed-payload") history[0].parts[0].text = "{broken request"
        if (variant === "invalid-digest") {
          const envelope = JSON.parse(stripInternalInitiatorMarkers(history[0].parts[0].text))
          envelope.request_digest = "0".repeat(64)
          history[0].parts[0].text = JSON.stringify(envelope)
        }
        if (variant === "wrong-model") history[0].info.model = { providerID: "ordinary", modelID: "different" }
        if (variant === "widened-tools") history[0].info.tools = { "*": true }
        const f = boundary(history, present)
        try {
          for (const agent of [undefined, formerName]) {
            expect(await f.runtime.guardSession("ses_ordinary", agent)).toBe(false)
            const output = { message: { id: "msg_ordinary", sessionID: "ses_ordinary" }, parts: [{ type: "text", text: "Ordinary request" }] }
            await f.chat({ sessionID: "ses_ordinary", ...(agent ? { agent } : {}) } as never, output as never)
            expect(output.parts.at(-1)?.text).toBe("ordinary callback reached")
          }
          expect(f.ordinaryCalls()).toBe(2)
          expect(f.runtime.ownsChild("ses_ordinary")).toBe(false)
        } finally { f.runtime.dispose() }
      })
    }
  }
})
