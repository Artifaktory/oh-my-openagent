import { describe, expect, test } from "bun:test"
import { interceptAutopilotTask } from "./autopilot-task"
import type { ToolContextWithMetadata } from "./types"

describe("Autopilot continuation identity", () => {
  test("#given restart and an obsolete native display name #when a retained private request is found #then it denies reuse without granting ownership", async () => {
    const client = { session: { messages: async () => ({ data: [{ info: { role: "user", agent: "old-review-name" },
      parts: [{ type: "text", text: JSON.stringify({ request: { protocol: "autopilot.gate-request.v1" } }) }] }] }) } }
    const result = await interceptAutopilotTask({ task_id: "retained-child" },
      { sessionID: "parent", agent: "sisyphus" } as ToolContextWithMetadata, { client } as never)
    expect(result).toContain("child_reuse")
  })
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
})
