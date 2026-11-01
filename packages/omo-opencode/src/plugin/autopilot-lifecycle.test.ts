import { describe, expect, test } from "bun:test"
import { createPluginInterface } from "../plugin-interface"
import { createAutopilotRuntime } from "../features/autopilot"
import { interceptAutopilotTask } from "../tools/delegate-task/autopilot-task"
import { createInternalAgentTextPart } from "../shared/internal-initiator-marker"
import { buildSyncPromptTools } from "../tools/delegate-task/sync-prompt-sender"

describe("mandatory Autopilot boundary without optional hooks", () => {
  const fixture = (present = true, sessionAgent = "Autopilot") => {
    const client = { session: { messages: async () => ({ data: [{ info: { agent: sessionAgent } }] }) } }
    const runtime = createAutopilotRuntime({ executor: { client, directory: process.cwd(), manager: {} } as never,
      nativeAgentNames: ["Native Gate"] })
    const plugin = createPluginInterface({ ctx: { client, directory: process.cwd() }, pluginConfig: {}, hooks: {}, managers: {},
      tools: {}, firstMessageVariantGate: {}, ...(present ? { autopilotRuntime: runtime } : {}) } as never)
    const chat = plugin["chat.message"], params = plugin["chat.params"], system = plugin["experimental.chat.system.transform"]
    const messages = plugin["experimental.chat.messages.transform"], tool = plugin["tool.execute.before"]
    if (!chat || !params || !system || !messages || !tool) throw Error("mandatory Autopilot hooks missing")
    const hooks = { "chat.message": chat, "chat.params": params, "experimental.chat.system.transform": system,
      "experimental.chat.messages.transform": messages, "tool.execute.before": tool }
    return { runtime, hooks, client }
  }
  test("#given unowned native Autopilot session #when handlers run #then every generation and tool path rejects it", async () => {
    const { runtime, hooks } = fixture()
    await expect(hooks["chat.message"]({ sessionID: "direct", agent: "autopilot" } as never, {} as never)).rejects.toThrow("unowned_child")
    await expect(hooks["chat.params"]({ sessionID: "direct", agent: { name: "autopilot" } } as never, {} as never)).rejects.toThrow("unowned_child")
    await expect(hooks["experimental.chat.system.transform"]({ sessionID: "direct", model: {} } as never, { system: [] })).rejects.toThrow("unowned_child")
    await expect(hooks["experimental.chat.messages.transform"]({}, { messages: [{ info: { sessionID: "direct", agent: "autopilot" }, parts: [] }] } as never)).rejects.toThrow("unowned_child")
    await expect(hooks["tool.execute.before"]({ sessionID: "direct", tool: "read", callID: "call" }, { args: {} })).rejects.toThrow("unowned_child")
    runtime.dispose()
  })
  test("#given missing runtime #when named Autopilot reaches generation #then it is explicit non-admission", async () => {
    const { runtime, hooks } = fixture(false)
    await expect(hooks["chat.message"]({ sessionID: "direct", agent: "autopilot" } as never, {} as never)).rejects.toThrow("runtime_unavailable")
    await expect(hooks["chat.params"]({ sessionID: "direct", agent: "autopilot" } as never, {} as never)).rejects.toThrow("runtime_unavailable")
    await expect(hooks["experimental.chat.system.transform"]({ sessionID: "direct", model: {} } as never, { system: [] })).rejects.toThrow("runtime_unavailable")
    await expect(hooks["tool.execute.before"]({ sessionID: "direct", tool: "read", callID: "call" }, { args: {} })).rejects.toThrow("runtime_unavailable")
    await expect(hooks["experimental.chat.messages.transform"]({}, { messages: [{ info: { sessionID: "direct", agent: "autopilot" }, parts: [] }] } as never)).rejects.toThrow("runtime_unavailable")
    runtime.dispose()
  })
  test.each(["autopilot", "Autopilot", "Native Gate"])("#given category plus %s #when native before precedes task execution #then the strict target guard rejects it", async target => {
    const { runtime, hooks, client } = fixture(true, "sisyphus")
    const output = { args: { subagent_type: target, category: "quick", prompt: "{}", run_in_background: false } }
    try {
      await hooks["tool.execute.before"]({ sessionID: "parent", tool: "task", callID: "call" }, output)
      const result = await interceptAutopilotTask(output.args, { sessionID: "parent", agent: "sisyphus", abort: new AbortController().signal } as never,
        { client: client as never, autopilotRuntime: runtime })
      expect(result).toBeDefined()
      expect(JSON.parse(result ?? "null")).toMatchObject({ protocol: "autopilot.result.v1", outcome: "human_required", error: "invalid_request", effect: "not_attempted" })
    } finally { runtime.dispose() }
  })
  test("#given ordinary category plus oracle #when native before executes #then category precedence remains", async () => {
    const { runtime, hooks } = fixture(true, "sisyphus")
    const output = { args: { subagent_type: "oracle", category: "quick" } }
    try {
      await hooks["tool.execute.before"]({ sessionID: "parent", tool: "task", callID: "call" }, output)
      expect(output.args.subagent_type).toBe("sisyphus-junior")
    } finally { runtime.dispose() }
  })
  for (const agent of ["explore", "custom-review-agent", "old-review-name"]) {
    for (const wrapped of [false, true]) {
      for (const present of [false, true]) {
        test(`R3-generation-${agent}-${wrapped ? "wrapped" : "raw"}-${present ? "runtime" : "no-runtime"} #given ordinary request-shaped data #when generation transforms messages #then preserve ordinary data`, async () => {
          const { runtime, hooks } = fixture(present, agent)
          const text = JSON.stringify({ request: { protocol: "autopilot.gate-request.v1" } })
          const part = wrapped ? createInternalAgentTextPart(text) : { type: "text", text }
          const output = { messages: [{ info: { id: "msg_data", sessionID: "ses_ordinary", role: "user", agent,
            model: { providerID: "test", modelID: "one" }, system: "Ordinary task fixture", tools: buildSyncPromptTools(agent) }, parts: [part] }] }
          const before = structuredClone(output)
          try {
            await hooks["experimental.chat.messages.transform"]({}, output as never)
            expect(output).toEqual(before)
            expect(runtime.ownsChild("ses_ordinary")).toBe(false)
          } finally { runtime.dispose() }
        })
      }
    }
  }
})
