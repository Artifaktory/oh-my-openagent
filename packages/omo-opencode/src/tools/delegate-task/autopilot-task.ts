import { isAutopilotAgent, isAutopilotTranscript, type AutopilotRuntime } from "../../features/autopilot"
import { normalizeSDKResponse } from "../../shared/normalize-sdk-response"
import type { DelegateTaskToolOptions, ToolContextWithMetadata } from "./types"

const rejected = (error: string) => JSON.stringify({ protocol: "autopilot.result.v1", outcome: "human_required", error, effect: "not_attempted" })

export async function interceptAutopilotTask(
  args: Record<string, unknown>, context: ToolContextWithMetadata,
  options: Pick<DelegateTaskToolOptions, "client"> & { autopilotRuntime?: AutopilotRuntime },
): Promise<string | undefined> {
  const runtime = options.autopilotRuntime
  if (isAutopilotAgent(context.agent) || runtime?.isAutopilotName(context.agent) || runtime?.ownsChild(context.sessionID)) return rejected("tool_forbidden")
  const named = isAutopilotAgent(args.subagent_type) || runtime?.isAutopilotName(args.subagent_type)
  const taskID = typeof args.task_id === "string" ? args.task_id : undefined
  if (named && taskID) return rejected("child_reuse")
  if (taskID) {
    try {
      if (runtime) {
        if (await runtime.isAutopilotSession(taskID)) return rejected("child_reuse")
      } else {
        const response = await options.client.session.messages({ path: { id: taskID } })
        const messages = normalizeSDKResponse(response, [] as { info?: { agent?: string } }[])
        if (!Array.isArray(messages)) return rejected("lineage_unresolved")
        if (isAutopilotTranscript(messages)) return rejected("child_reuse")
      }
    } catch { return rejected("lineage_unresolved") }
  }
  if (!named) return undefined
  if (!runtime) return rejected("runtime_unavailable")
  if (args.run_in_background === true) return rejected("background_unsupported")
  if (args.category !== undefined || args.command !== undefined || typeof args.prompt !== "string"
    || (args.load_skills !== undefined && (!Array.isArray(args.load_skills) || args.load_skills.some(skill => typeof skill !== "string")))) {
    return rejected("invalid_request")
  }
  const result = await runtime.invoke(args.prompt, context, args.load_skills as string[] | undefined)
  if (!result.ok) return rejected(result.error)
  return JSON.stringify({ protocol: "autopilot.result.v1", decision: result.decision,
    invocation_id: result.receipt.invocation_id, request_digest: result.receipt.request_digest,
    scope: result.receipt.scope, provenance: result.receipt.provenance, policy: result.receipt.bindings.policy, effect: "not_attempted" })
}
