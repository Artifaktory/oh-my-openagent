import { randomUUID } from "node:crypto"
import { realpathSync } from "node:fs"
import type { OmoConfigEnv } from "@oh-my-opencode/omo-config-core"
import { parseFrontmatter } from "../../shared/frontmatter"
import { normalizeSDKResponse } from "../../shared/normalize-sdk-response"
import { getAvailableModelsForDelegateTask } from "../../tools/delegate-task/available-models"
import { resolveSubagentAgentMatch } from "../../tools/delegate-task/subagent-agent-match"
import { getAgentDisplayName } from "../../shared/agent-display-names"
import type { ExecutorContext } from "../../tools/delegate-task/executor-types"
import type { ToolContextWithMetadata } from "../../tools/delegate-task/types"
import type { SyncTaskDeps } from "../../tools/delegate-task/sync-task-deps"
import { createSyncAdmission, SyncAdmissionError } from "../../tools/delegate-task/sync-admission"
import { validatePluginConfig } from "../../config/validate"
import { createAutopilotAgent } from "../../agents/autopilot"
import { autopilotAuthorityIdentity, getAutopilotBinding } from "./authority"
import { createAutopilotChildRegistry, isAutopilotAgent, isAutopilotTranscript } from "./child-registry"
import { captureAssessment, captureHostAssessment } from "./decision-validation"
import { composeInstructionSnapshot } from "./instruction-snapshot"
import { projectAutopilotNativeConfig, refreshAutopilotNativeConfig, readAutopilotInstructionView } from "./native-config"
import { readPolicyFile } from "./policy-file-reader"
import { capturePolicySnapshot } from "./policy-snapshot"
import { captureGateRequest } from "./protocol"
import { createReceiptLedger, type DecisionReceipt } from "./receipt"
import { runAutopilotDecision } from "./sync-decision-runner"
import { AutopilotError, type ModelDecision } from "./types"

const DECISION_PROTOCOL = 'Return one JSON object with protocol="autopilot.model-decision.v1", invocation_id, request_digest, outcome (approve, rework, select_option, human_required), reason_codes, evidence_ids and explanation. reason_codes must contain 1 to 16 strings, each matching ^[a-z][a-z0-9_]{0,63}$. Only select_option includes option_id. Copy the supplied invocation and request digest. No markdown, tool authority, signatures or effects.'

export type AutopilotInvocationResult = { readonly ok: true; readonly decision: ModelDecision; readonly receipt: DecisionReceipt }
  | { readonly ok: false; readonly error: string; readonly outcome: "human_required" }

export function createAutopilotRuntime(options: {
  readonly executor: ExecutorContext
  readonly worktree?: string
  readonly nativeAgentNames?: readonly string[]
  readonly environment?: OmoConfigEnv
  readonly nativeDeps?: SyncTaskDeps
  readonly readModels?: () => Promise<{ availableModels: Set<string>; systemDefaultModel?: string }>
}) {
  const { executor } = options
  const registry = createAutopilotChildRegistry()
  const nativeNames = new Set(options.nativeAgentNames ?? [])
  const isAutopilotName = (value: unknown): boolean => isAutopilotAgent(value)
    || (typeof value === "string" && nativeNames.has(value))
    || (typeof value === "object" && value !== null && "name" in value && typeof value.name === "string" && nativeNames.has(value.name))
  const ledger = createReceiptLedger()
  const active = new Map<string, { parent: string; controller: AbortController }>()
  let disposed = false
  const readModels = options.readModels ?? (async () => {
    const availableModels = await getAvailableModelsForDelegateTask(executor.client)
    const response = await executor.client.config.get()
    const config = normalizeSDKResponse(response, {} as { model?: string })
    return { availableModels, systemDefaultModel: config.model }
  })
  const hasAutopilotHistory = async (sessionID: string): Promise<boolean> => {
    const response = await executor.client.session.messages({ path: { id: sessionID } })
    const messages = normalizeSDKResponse(response, [] as { info?: { agent?: string } }[])
    return isAutopilotTranscript(messages, isAutopilotName)
  }
  return {
    ownsChild: registry.has,
    isAutopilotName,
    isReceipt: ledger.owns,
    async guardSession(sessionID: string, agent?: unknown): Promise<boolean> {
      if (registry.has(sessionID)) { registry.require(sessionID, agent); return true }
      if (isAutopilotName(agent)) throw new AutopilotError("unowned_child")
      if (sessionID && await hasAutopilotHistory(sessionID)) throw new AutopilotError("unowned_child")
      return false
    },
    chat: registry.chat, params: registry.params, system: registry.system, messages: registry.messages, tool: registry.tool,
    async isAutopilotSession(sessionID: string): Promise<boolean> { return registry.has(sessionID) || await hasAutopilotHistory(sessionID) },
    event(event: { type: string; properties?: Record<string, unknown> }): boolean {
      const properties = event.properties ?? {}
      const info = properties.info as { id?: string } | undefined
      const sessionID = typeof properties.sessionID === "string" ? properties.sessionID : info?.id
      if (!sessionID) return false
      const owned = registry.has(sessionID)
      if (["session.deleted", "session.error"].includes(event.type)) {
        if (owned) registry.stop(sessionID)
        for (const invocation of active.values()) if (invocation.parent === sessionID) invocation.controller.abort()
      }
      return owned
    },
    dispose() { disposed = true; for (const invocation of active.values()) invocation.controller.abort(); registry.stopAll() },
    async invoke(payload: string, context: ToolContextWithMetadata, callerSkills: readonly string[] = []): Promise<AutopilotInvocationResult> {
      const started = Date.now()
      const capturedContext = { sessionID: context.sessionID, messageID: context.messageID, agent: context.agent,
        callID: context.callID ?? context.callId ?? context.call_id, abort: context.abort }
      const skills = [...callerSkills]
      const invocationID = randomUUID()
      const controller = new AbortController()
      let admission: ReturnType<typeof createSyncAdmission> | undefined
      active.set(invocationID, { parent: capturedContext.sessionID, controller })
      const stopChildren: string[] = []
      let deadline = started + 120000
      try {
        if (disposed) throw new AutopilotError("runtime_unavailable")
        if (isAutopilotName(capturedContext.agent) || registry.has(capturedContext.sessionID)) throw new AutopilotError("tool_forbidden")
        const assessment = captureAssessment(payload)
        const validated = validatePluginConfig(executor.directory, options.environment)
        const initialBinding = getAutopilotBinding(validated.config.agents)
        if (!initialBinding || initialBinding.state !== "enabled") throw new AutopilotError("invalid_configuration")
        deadline = started + initialBinding.limits.timeout_ms
        const guard = createSyncAdmission({ invocationId: invocationID, waiterId: `autopilot:${invocationID}`,
          signal: controller.signal, deadline }, capturedContext.abort)
        admission = guard
        const modelOptions = await guard.run(readModels)
        if (!modelOptions.availableModels.size) throw new AutopilotError("invalid_configuration")
        const refresh = () => refreshAutopilotNativeConfig(executor.directory, { ...modelOptions, callerSkills: skills }, options.environment)
        const projection = projectAutopilotNativeConfig(validated.config.agents, { ...modelOptions, callerSkills: skills })
        const binding = projection.binding
        const enrollment = binding.enrollment
        if (!enrollment) throw new AutopilotError("invalid_configuration")
        const check = () => { guard.check(); if (Date.now() >= deadline) throw new AutopilotError("request_expired") }
        check()
        const authority = autopilotAuthorityIdentity(binding)
        const policy = await guard.run(() => capturePolicySnapshot({ directory: binding.workspace, roots: enrollment.policy_roots,
          manifestPath: enrollment.manifest, enrollment: enrollment.sources, maxFileBytes: binding.limits.max_file_bytes,
          maxTotalBytes: binding.limits.max_total_bytes, maxSources: binding.limits.max_sources,
          readNativeView: async () => {
            check()
            const current = refresh()
            if (autopilotAuthorityIdentity(current.binding) !== authority) throw new AutopilotError("authority_revoked")
            return readAutopilotInstructionView(current, async (source, name) => {
              check()
              const captured = await readPolicyFile(source.source, { directory: binding.workspace, roots: enrollment.policy_roots,
                maxFileBytes: binding.limits.max_file_bytes })
              const parsed = parseFrontmatter<{ name?: string; agent?: string; model?: unknown; subtask?: unknown; mcp?: unknown }>(captured.text)
              if (parsed.parseError || (parsed.data.name !== undefined && parsed.data.name !== name)
                || (parsed.data.agent !== undefined && !isAutopilotAgent(parsed.data.agent))
                || parsed.data.model !== undefined || parsed.data.subtask !== undefined || parsed.data.mcp !== undefined) {
                throw new AutopilotError("invalid_configuration")
              }
              return parsed.body.trim()
            })
          } }))
        check()
        if (policy.configurationDigest !== projection.configurationDigest) throw new AutopilotError("source_changed")
        const factory = createAutopilotAgent(projection.models[0].model).prompt
        if (typeof factory !== "string" || !factory) throw new AutopilotError("invalid_configuration")
        const instructions = composeInstructionSnapshot(policy, { pluginRevision: "autopilot-producer-v1",
          factory, protocol: DECISION_PROTOCOL })
        const expectedAgent = getAgentDisplayName("autopilot", binding.config.agents)
        nativeNames.add(expectedAgent)
        const nativeAgent = await guard.run(() => resolveSubagentAgentMatch(expectedAgent,
          { ...executor, claudeCodeAgentsEnabled: false }, {}))
        if (nativeAgent.kind !== "matched" || nativeAgent.matchedAgent.mode !== "subagent") throw new AutopilotError("invalid_configuration")
        nativeNames.add(nativeAgent.agentToUse)
        const immutableContext = { ...capturedContext, abort: guard.signal }
        if (!immutableContext.callID || !immutableContext.agent) throw new AutopilotError("invalid_request")
        const host = await guard.run(() => captureHostAssessment({ assessment, binding, context: immutableContext,
          client: executor.client, deadline, check }))
        const models = projection.models.map(model => { const separator = model.model.indexOf("/")
          return { providerID: model.model.slice(0, separator), modelID: model.model.slice(separator + 1),
            ...((model.reasoning ?? model.variant ?? model.reasoningEffort) ? { reasoning: model.reasoning ?? model.variant ?? model.reasoningEffort } : {}) } })
        const request = captureGateRequest({ protocol: "autopilot.gate-request.v1", invocation_id: invocationID, created_at: started,
          deadline, action: "task_update.completed_revision", host: { workspace: binding.workspace,
            worktree: realpathSync(options.worktree ?? executor.directory), parent_session_id: immutableContext.sessionID,
            tool_call_id: immutableContext.callID, caller_session_id: immutableContext.sessionID, caller_agent: immutableContext.agent },
          ...host, policy: { revision: policy.manifest.revision, manifest_digest: policy.manifestDigest,
            policy_digest: policy.policyDigest, instruction_digest: instructions.digest, configuration_digest: projection.configurationDigest },
          models, dispatch: models[0], permission_ceiling: projection.allowedTools }, Date.now(), guard.signal).request
        const result = await guard.run(() => runAutopilotDecision({ executor, context: immutableContext, request,
          nativeAgent: nativeAgent.agentToUse,
          projection, instructions, registry, admission: { invocationId: invocationID, waiterId: `autopilot:${invocationID}`,
            signal: guard.signal, deadline }, deps: options.nativeDeps }))
        stopChildren.push(result.child.sessionID)
        check()
        const current = validatePluginConfig(executor.directory, options.environment)
        const currentBinding = getAutopilotBinding(current.config.agents)
        if (!currentBinding || currentBinding.state !== "enabled" || autopilotAuthorityIdentity(currentBinding) !== authority) {
          throw new AutopilotError("authority_revoked")
        }
        check()
        return { ok: true, decision: result.decision, receipt: ledger.issue(result.child.request, result.decision, result.final, result.child, authority) }
      } catch (error) {
        const code = Date.now() >= deadline ? "request_expired" : capturedContext.abort.aborted || admission?.signal.aborted ? "request_cancelled"
          : error instanceof AutopilotError ? error.code : error instanceof SyncAdmissionError ? error.code : "native_result_invalid"
        return { ok: false, error: code, outcome: "human_required" }
      } finally {
        for (const child of stopChildren) registry.stop(child)
        controller.abort(); admission?.dispose(); active.delete(invocationID)
      }
    },
  }
}
export type AutopilotRuntime = ReturnType<typeof createAutopilotRuntime>
