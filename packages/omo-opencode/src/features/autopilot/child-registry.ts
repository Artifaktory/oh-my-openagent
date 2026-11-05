import path from "node:path"
import { lstat, realpath, readdir } from "node:fs/promises"
import { getAgentConfigKey } from "../../shared/agent-display-names"
import { applySessionPromptParams } from "../../shared/session-prompt-params-helpers"
import { getSessionPromptParams } from "../../shared/session-prompt-params-state"
import { createChatParamsHandler } from "../../plugin/chat-params"
import { stripInternalInitiatorMarkers } from "../../shared/internal-initiator-marker"
import { createAutopilotAgent } from "../../agents/autopilot"
import type { DelegatedModelConfig } from "../../tools/delegate-task/types"
import { canonicalJson, GateRequestSchema, sha256 } from "./protocol"
import { AutopilotError, type GateRequest, type InstructionSnapshot } from "./types"

export interface OwnedAutopilotChild {
  readonly sessionID: string
  readonly parentID: string
  readonly nativeAgent: string
  readonly request: GateRequest
  readonly instructions: InstructionSnapshot
  readonly model: DelegatedModelConfig
  readonly messageID: string
  readonly prompt: string
  readonly dispatchedAt: number
  readonly signal: AbortSignal
  readonly tools: Readonly<Record<string, boolean>>
  readonly roots: readonly string[]
  readonly attempt: number
  active: boolean
  observed: { chat: boolean; system: boolean; messages: boolean; params: boolean; reasoning?: string; parameters?: string }
}

export function isAutopilotAgent(value: unknown): boolean {
  const name = typeof value === "string" ? value : value && typeof value === "object" && "name" in value ? value.name : undefined
  return typeof name === "string" && getAgentConfigKey(name) === "autopilot"
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/** Native producer context can deny reuse after restart, but never establishes ownership. */
export function isAutopilotTranscript(messages: unknown, matches: (agent: unknown) => boolean = isAutopilotAgent): boolean {
  if (!Array.isArray(messages)) return false
  return messages.some(message => {
    const value = record(message), info = record(value.info)
    if (matches(info.agent)) return true
    if (info.role !== "user" || typeof info.agent !== "string" || !info.agent
      || typeof info.id !== "string" || typeof info.sessionID !== "string"
      || typeof info.system !== "string" || !Array.isArray(value.parts)) return false
    const model = record(info.model), tools = record(info.tools)
    if (tools["*"] !== false) return false
    return value.parts.some(part => {
      const text = record(part).text
      if (record(part).type !== "text" || typeof text !== "string" || Buffer.byteLength(text) > 266240) return false
      try {
        const envelope = record(JSON.parse(stripInternalInitiatorMarkers(text)))
        const parsed = GateRequestSchema.safeParse(envelope.request)
        if (!parsed.success || envelope.request_digest !== sha256(canonicalJson(parsed.data))) return false
        const request = parsed.data
        if (model.providerID !== request.dispatch.providerID || model.modelID !== request.dispatch.modelID) return false
        const expectedTools = { "*": false, ...Object.fromEntries(request.permission_ceiling.map(tool => [tool, true])) }
        if (canonicalJson(tools) !== canonicalJson(expectedTools)) return false
        const factory = createAutopilotAgent(`${request.dispatch.providerID}/${request.dispatch.modelID}`).prompt
        return typeof factory === "string" && factory.length > 0 && String(info.system).startsWith(factory + "\n\n")
      }
      catch { return false }
    })
  })
}

function forbiddenPath(value: string): boolean {
  const normalized = value.replace(/\\/g, "/")
  return normalized.includes("\0") || normalized.startsWith("//") || /(^|\/)\.\.(\/|$)/.test(normalized)
    || normalized.replace(/^[a-z]:/i, "").includes(":")
    || /(^|\/)(\.env[^/]*|\.ssh|\.aws|\.azure|\.gnupg|\.codex|\.config|\.git|\.npmrc|[^/]*secret[^/]*|[^/]*credential[^/]*|auth\.json|id_rsa|id_ed25519)(\/|$)/i.test(normalized)
    || /\.(pem|key|p12|pfx)$/i.test(normalized)
}

async function validateToolPath(value: string, roots: readonly string[], workspace: string, recursive: boolean): Promise<string> {
  if (forbiddenPath(value)) throw new AutopilotError("source_forbidden")
  const candidate = path.resolve(workspace, value)
  const canonical = await realpath(candidate)
  if (path.relative(candidate, canonical) !== "" || forbiddenPath(canonical)) throw new AutopilotError("source_forbidden")
  const root = roots.find(root => { const relative = path.relative(root, canonical)
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) })
  if (!root) throw new AutopilotError("source_forbidden")
  let cursor = canonical
  while (cursor !== root) {
    if ((await lstat(cursor)).isSymbolicLink()) throw new AutopilotError("source_forbidden")
    const parent = path.dirname(cursor)
    if (parent === cursor) throw new AutopilotError("source_forbidden")
    cursor = parent
  }
  const pending = [canonical]
  let count = 0
  while (true) {
    const current = pending.pop()
    if (current === undefined) break
    if (++count > 4096 || forbiddenPath(current)) throw new AutopilotError("source_forbidden")
    const entry = await lstat(current)
    if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) throw new AutopilotError("source_forbidden")
    if (entry.isDirectory()) {
      if (!recursive) throw new AutopilotError("source_forbidden")
      for (const child of await readdir(current)) pending.push(path.join(current, child))
    }
  }
  return canonical
}

export function createAutopilotChildRegistry() {
  const children = new Map<string, OwnedAutopilotChild>()
  const retired = new Set<string>()
  const has = (sessionID: string) => children.has(sessionID) || retired.has(sessionID)
  const stop = (sessionID: string) => {
    const child = children.get(sessionID)
    if (!child) return
    child.active = false
    children.delete(sessionID)
    retired.add(sessionID)
  }
  const requireChild = (sessionID: string, agent?: unknown): OwnedAutopilotChild | undefined => {
    if (retired.has(sessionID)) throw new AutopilotError("request_cancelled")
    const child = children.get(sessionID)
    if (!child) {
      if (isAutopilotAgent(agent)) throw new AutopilotError("unowned_child")
      return undefined
    }
    if (!child.active || child.signal.aborted) throw new AutopilotError("request_cancelled")
    if (Date.now() >= child.request.deadline) throw new AutopilotError("request_expired")
    const name = typeof agent === "object" && agent !== null && "name" in agent ? agent.name : agent
    if (name !== undefined && name !== child.nativeAgent && !isAutopilotAgent(name)) throw new AutopilotError("decision_mismatch")
    return child
  }
  const assertModel = (child: OwnedAutopilotChild, value: unknown) => {
    const model = record(value)
    if (model.providerID !== child.model.providerID || (model.modelID ?? model.id) !== child.model.modelID) {
      throw new AutopilotError("decision_mismatch")
    }
  }
  return {
    has,
    get: (sessionID: string) => children.get(sessionID),
    require: requireChild,
    register(child: OwnedAutopilotChild) {
      if (has(child.sessionID)) throw new AutopilotError("child_reuse")
      children.set(child.sessionID, child)
      child.signal.addEventListener("abort", stop.bind(undefined, child.sessionID), { once: true })
      if (child.signal.aborted) stop(child.sessionID)
    },
    stop,
    stopAll() { for (const sessionID of children.keys()) stop(sessionID) },
    chat(input: unknown, output: unknown): boolean {
      const raw = record(input), out = record(output), message = record(out.message)
      const child = requireChild(String(raw.sessionID ?? message.sessionID ?? ""), raw.agent ?? message.agent)
      if (!child) return false
      if ((raw.messageID ?? message.id) !== child.messageID) throw new AutopilotError("child_reuse")
      if (raw.model !== undefined) assertModel(child, raw.model)
      message.agent = child.nativeAgent; message.model = { providerID: child.model.providerID, modelID: child.model.modelID }
      message.system = child.instructions.text; message.tools = { ...child.tools }
      out.message = message
      if (!Array.isArray(out.parts) || out.parts.length !== 1 || record(out.parts[0]).type !== "text"
        || record(out.parts[0]).text !== child.prompt) throw new AutopilotError("decision_mismatch")
      child.observed.chat = true
      return true
    },
    async params(input: unknown, output: unknown): Promise<boolean> {
      const raw = record(input), out = record(output)
      const child = requireChild(String(raw.sessionID ?? ""), raw.agent)
      if (!child) return false
      assertModel(child, raw.model)
      const lowered = applySessionPromptParams(child.sessionID, { ...child.model, runtimeModel: record(raw.model) })
      const message = record(raw.message)
      const variant = child.model.reasoning === undefined ? child.model.variant : lowered.variant
      if (variant === undefined) delete message.variant
      else message.variant = variant
      const params = getSessionPromptParams(child.sessionID) ?? {}
      for (const key of ["temperature", "topP", "topK", "maxOutputTokens", "options"]) delete out[key]
      Object.assign(out, params, { options: { ...record(params.options) } })
      await createChatParamsHandler()(input, output)
      requireChild(child.sessionID, "autopilot")
      child.observed.params = true
      child.observed.reasoning = typeof message.variant === "string" ? message.variant
        : typeof record(out.options).reasoningEffort === "string" ? String(record(out.options).reasoningEffort) : undefined
      child.observed.parameters = canonicalJson(JSON.parse(JSON.stringify(out)))
      return true
    },
    system(input: unknown, output: unknown): boolean {
      const raw = record(input), out = record(output)
      const child = requireChild(String(raw.sessionID ?? ""), raw.agent)
      if (!child) return false
      assertModel(child, raw.model)
      out.system = [child.instructions.text]
      child.observed.system = true
      return true
    },
    messages(output: unknown): boolean {
      const out = record(output)
      if (!Array.isArray(out.messages)) return false
      const messages = out.messages.map(record)
      const infos = messages.map(message => record(message.info))
      const sessionIDs = new Set(infos.map(info => String(info.sessionID ?? "")))
      const ownedID = [...sessionIDs].find(has)
      const autopilot = isAutopilotTranscript(out.messages)
      const child = requireChild(ownedID ?? String(infos[0]?.sessionID ?? ""), autopilot ? "autopilot" : undefined)
      if (!child) return false
      if (sessionIDs.size !== 1 || !sessionIDs.has(child.sessionID)) throw new AutopilotError("decision_mismatch")
      const users = messages.filter(message => record(message.info).role === "user")
      if (users.length !== 1 || record(users[0].info).id !== child.messageID) throw new AutopilotError("child_reuse")
      const parts = users[0].parts
      if (!Array.isArray(parts) || !parts.length) throw new AutopilotError("decision_mismatch")
      users[0].parts = [{ ...record(parts[0]), type: "text", text: child.prompt }]
      Object.assign(record(users[0].info), { system: child.instructions.text, tools: { ...child.tools } })
      child.observed.messages = true
      return true
    },
    async tool(sessionID: string, tool: string, args: Record<string, unknown>, agent?: unknown): Promise<boolean> {
      const child = requireChild(sessionID, agent)
      if (!child) return false
      if (!["read", "glob", "grep"].includes(tool) || child.tools[tool] !== true) throw new AutopilotError("tool_forbidden")
      const allowed = tool === "read" ? ["filePath", "offset", "limit"] : tool === "glob" ? ["pattern", "path"] : ["pattern", "path", "include"]
      if (Object.keys(args).some(key => !allowed.includes(key))) throw new AutopilotError("tool_forbidden")
      const target = tool === "read" ? args.filePath : args.path
      if (typeof target !== "string" || !target) throw new AutopilotError("source_forbidden")
      for (const key of ["pattern", "include"]) {
        if (key === "pattern" && tool === "grep") continue
        if (args[key] !== undefined && (typeof args[key] !== "string" || forbiddenPath(String(args[key])) || path.isAbsolute(String(args[key])))) {
          throw new AutopilotError("source_forbidden")
        }
      }
      const validated = await validateToolPath(target, child.roots, child.request.host.workspace, tool !== "read")
      requireChild(sessionID, agent)
      args[tool === "read" ? "filePath" : "path"] = validated
      return true
    },
    verified(sessionID: string): OwnedAutopilotChild {
      const child = requireChild(sessionID, "autopilot")
      if (!child) throw new AutopilotError("unowned_child")
      if (!child.observed.chat || !child.observed.system || !child.observed.messages || !child.observed.params) {
        throw new AutopilotError("context_unverified")
      }
      return child
    },
  }
}
export type AutopilotChildRegistry = ReturnType<typeof createAutopilotChildRegistry>
