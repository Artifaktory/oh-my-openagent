import { createInternalAgentTextPart } from "../../shared/internal-initiator-marker"
import type { ExecutorContext } from "../../tools/delegate-task/executor-types"
import type { DelegateTaskArgs, DelegatedModelConfig, ToolContextWithMetadata } from "../../tools/delegate-task/types"
import { executeSyncTask } from "../../tools/delegate-task/sync-task"
import { syncTaskDeps, type SyncTaskDeps } from "../../tools/delegate-task/sync-task-deps"
import { fetchAutopilotFinalResult, type NativeFinalResult } from "../../tools/delegate-task/sync-result-fetcher"
import type { SyncAdmissionRecord } from "../../tools/delegate-task/sync-admission"
import type { AutopilotNativeProjection } from "./native-config"
import type { AutopilotChildRegistry, OwnedAutopilotChild } from "./child-registry"
import { canonicalJson, captureGateRequest } from "./protocol"
import { validateNativeDecision } from "./decision-validation"
import { createAutopilotMessageID } from "./native-message-id"
import { AutopilotError, type GateRequest, type InstructionSnapshot } from "./types"

function delegatedModels(projection: AutopilotNativeProjection): DelegatedModelConfig[] {
  return projection.models.map(entry => {
    const separator = entry.model.indexOf("/")
    if (separator < 1) throw new AutopilotError("invalid_configuration")
    const { model: _model, ...settings } = entry
    return { ...settings, providerID: entry.model.slice(0, separator), modelID: entry.model.slice(separator + 1),
      tools: { ...projection.agent.tools } }
  })
}

export async function runAutopilotDecision(input: {
  readonly executor: ExecutorContext; readonly context: ToolContextWithMetadata; readonly request: GateRequest
  readonly nativeAgent: string
  readonly projection: AutopilotNativeProjection; readonly instructions: InstructionSnapshot
  readonly registry: AutopilotChildRegistry; readonly admission: SyncAdmissionRecord
  readonly deps?: SyncTaskDeps
}) {
  const { executor, context, projection, instructions, registry, admission } = input
  const native = input.deps ?? syncTaskDeps
  const models = delegatedModels(projection)
  const children = new Map<string, DelegatedModelConfig>()
  const completed: { final?: NativeFinalResult; child?: OwnedAutopilotChild; nativeSessionID?: string } = {}
  let attempted = 0
  const deps: SyncTaskDeps = {
    ...native,
    capturedFallbackModels: models.slice(1, 2),
    onSessionAbandoned: sessionID => registry.stop(sessionID),
    onNativeCompleted: sessionID => { completed.nativeSessionID = sessionID },
    async createSyncSession(client, options) {
      if (attempted++ >= models.length) throw new AutopilotError("native_result_invalid")
      const ownedPermissions: { permission: string; pattern: string; action: "allow" | "deny" | "ask" }[] = []
      for (const [permission, value] of Object.entries(projection.agent.permission ?? {})) {
        const rules = typeof value === "string" ? { "*": value } : value
        if (!rules || typeof rules !== "object") throw new AutopilotError("invalid_configuration")
        for (const [pattern, action] of Object.entries(rules)) {
          if (action !== "allow" && action !== "deny" && action !== "ask") throw new AutopilotError("invalid_configuration")
          ownedPermissions.push({ permission, pattern, action })
        }
      }
      const result = await native.createSyncSession(client, { ...options, ownedPermissions })
      if (result.ok) {
        const model = options.categoryModel
        if (!model || model.providerID !== models[attempted - 1].providerID || model.modelID !== models[attempted - 1].modelID) {
          await client.session.abort({ path: { id: result.sessionID } }).catch(() => undefined)
          throw new AutopilotError("decision_mismatch")
        }
        children.set(result.sessionID, model)
      }
      return result
    },
    async sendSyncPrompt(client, options, promptDeps) {
      const model = children.get(options.sessionID)
      if (!model || registry.has(options.sessionID)) throw new AutopilotError("child_reuse")
      const captured = captureGateRequest({ ...input.request, dispatch: { providerID: model.providerID, modelID: model.modelID,
        ...((model.reasoning ?? model.variant ?? model.reasoningEffort) ? { reasoning: model.reasoning ?? model.variant ?? model.reasoningEffort } : {}) } }, Date.now(), admission.signal)
      const messageID = createAutopilotMessageID()
      const prompt = createInternalAgentTextPart(canonicalJson({ request: captured.request, request_digest: captured.digest })).text
      const child: OwnedAutopilotChild = { sessionID: options.sessionID, parentID: context.sessionID, request: captured.request,
        nativeAgent: input.nativeAgent,
        instructions, model, messageID, prompt, dispatchedAt: Date.now(), signal: admission.signal,
        tools: { ...projection.agent.tools }, roots: projection.binding.enrollment?.evidence_roots ?? [], attempt: attempted - 1,
        active: true, observed: { chat: false, system: false, messages: false, params: false } }
      registry.register(child)
      return native.sendSyncPrompt(client, { ...options, args: { ...options.args, prompt }, systemContent: instructions.text,
        categoryModel: model, ownedPrompt: { messageID, tools: child.tools } }, promptDeps)
    },
    async fetchSyncResult(client, sessionID) {
      try {
        const child = registry.verified(sessionID)
        const result = await fetchAutopilotFinalResult(client, { sessionID, promptMessageID: child.messageID,
          nativeAgent: child.nativeAgent,
          dispatchedAt: child.dispatchedAt, providerID: child.model.providerID, modelID: child.model.modelID, signal: admission.signal })
        validateNativeDecision(result, child.request, admission.signal)
        completed.final = result; completed.child = child
        return { ok: true, textContent: result.text }
      } catch { return { ok: false, error: "Autopilot final result rejected" } }
    },
  }
  const args: DelegateTaskArgs = { description: "Autopilot gate assessment", prompt: "owned request pending",
    subagent_type: "autopilot", run_in_background: false, load_skills: [] }
  await executeSyncTask(args, context, { ...executor, modelFallbackControllerAccessor: undefined, sisyphusAgentConfig: undefined },
    { sessionID: context.sessionID, messageID: context.messageID, agent: context.agent }, input.nativeAgent, models[0], instructions.text,
    undefined, undefined, deps, admission)
  if (!completed.final || !completed.child || completed.nativeSessionID !== completed.child.sessionID || admission.signal.aborted) {
    throw new AutopilotError("native_result_invalid")
  }
  registry.verified(completed.child.sessionID)
  return { final: completed.final, child: completed.child, decision: validateNativeDecision(completed.final, completed.child.request, admission.signal) }
}
