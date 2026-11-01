import { describe, expect, test } from "bun:test"
import { interceptAutopilotTask } from "./autopilot-task"
import type { ToolContextWithMetadata } from "./types"
import { createAutopilotRuntime } from "../../features/autopilot"
import { createInternalAgentTextPart } from "../../shared/internal-initiator-marker"
import { buildSyncPromptTools } from "./sync-prompt-sender"

describe("Autopilot continuation identity", () => {
  const context = { sessionID: "parent", agent: "sisyphus", abort: new AbortController().signal } as ToolContextWithMetadata
  test("#given task_id-only or false named identity #when actual child was Autopilot #then continuation is rejected", async () => {
    const options = { client: { session: { messages: async () => ({ data: [{ info: { role: "assistant", agent: "Autopilot" } }] }) } } }
    for (const args of [{ task_id: "ses_old" }, { task_id: "ses_old", subagent_type: "explore", run_in_background: true }]) {
      expect(await interceptAutopilotTask(args, context, options as never)).toContain("child_reuse")
    }
  })
  test("#given a valid ordinary continuation #when actual agent is resolved #then native continuation stays available", async () => {
    const options = { client: { session: { messages: async () => ({ data: [{ info: { role: "assistant", agent: "explore" } }] }) } } }
    expect(await interceptAutopilotTask({ task_id: "ses_normal" }, context, options as never)).toBeUndefined()
  })
  for (const agent of ["explore", "custom-review-agent", "old-review-name"]) {
    for (const wrapped of [false, true]) {
      for (const present of [false, true]) {
        test(`R3-continuation-${agent}-${wrapped ? "wrapped" : "raw"}-${present ? "runtime" : "no-runtime"} #given ordinary request-shaped data #when task_id resumes #then ordinary continuation remains available`, async () => {
          const text = JSON.stringify({ request: { protocol: "autopilot.gate-request.v1" } })
          const part = wrapped ? createInternalAgentTextPart(text) : { type: "text", text }
          const client = { session: { messages: async () => ({ data: [{ info: {
            id: "msg_data", sessionID: "ses_normal", role: "user", agent,
            model: { providerID: "test", modelID: "one" }, system: "Ordinary task fixture", tools: buildSyncPromptTools(agent),
          }, parts: [part] }] }) } }
          const runtime = createAutopilotRuntime({ executor: { client, directory: process.cwd(), manager: {} } as never })
          try {
            const options = { client: client as never, ...(present ? { autopilotRuntime: runtime } : {}) }
            for (const args of [{ task_id: "ses_normal" }, { task_id: "ses_normal", subagent_type: agent, run_in_background: true }]) {
              expect(await interceptAutopilotTask(args, context, options)).toBeUndefined()
            }
            expect(runtime.ownsChild("ses_normal")).toBe(false)
          } finally { runtime.dispose() }
        })
      }
    }
  }
})
