import { describe, expect, test } from "bun:test"
import { createDelegateTask } from "./tools"
import { interceptAutopilotTask } from "./autopilot-task"
import type { DelegateTaskToolOptions, ToolContextWithMetadata } from "./types"

describe("Autopilot named task admission", () => {
  const context = { sessionID: "parent", messageID: "message", agent: "sisyphus", abort: new AbortController().signal } as ToolContextWithMetadata
  for (const args of [ { subagent_type: "autopilot" }, { subagent_type: "Autopilot", run_in_background: true },
    { subagent_type: "autopilot", task_id: "ses_old" }, { subagent_type: "autopilot", category: "quick" } ]) {
    test(`#given ${JSON.stringify(args)} #when runtime is unavailable #then admission fails before skill materialization`, async () => {
      let skillReads = 0
      const task = createDelegateTask({ client: {}, manager: {}, directory: process.cwd(),
        nativeSkills: { all: async () => { skillReads++; throw Error("not allowed") } } } as unknown as DelegateTaskToolOptions)
      const result = await task.execute({ ...args, prompt: "untrusted", load_skills: ["must-not-read"] }, context as never)
      expect(result).toContain("human_required"); expect(skillReads).toBe(0)
    })
  }
  test("#given ordinary named or category task #when intercepted #then the ordinary path is retained", async () => {
    for (const args of [{ subagent_type: "explore" }, { category: "quick" }, { run_in_background: true, subagent_type: "oracle" }]) {
      expect(await interceptAutopilotTask(args, context, { client: {} } as never)).toBeUndefined()
    }
  })
})
