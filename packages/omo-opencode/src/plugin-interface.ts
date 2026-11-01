import type { PluginContext, PluginInterface, ToolsRecord } from "./plugin/types"
import type { OhMyOpenCodeConfig } from "./config"

import { applyAgentVariant } from "./shared/agent-variant"
import { createChatParamsHandler } from "./plugin/chat-params"
import { createChatHeadersHandler } from "./plugin/chat-headers"
import { createChatMessageHandler } from "./plugin/chat-message"
import { createCommandExecuteBeforeHandler } from "./plugin/command-execute-before"
import { createMessagesTransformHandler } from "./plugin/messages-transform"
import { createSystemTransformHandler } from "./plugin/system-transform"
import { getUltraworkMessage } from "./hooks/keyword-detector/ultrawork"
import { createEventHandler } from "./plugin/event"
import { createToolDefinitionHandler } from "./plugin/tool-definition"
import { createToolExecuteAfterHandler } from "./plugin/tool-execute-after"
import { createToolExecuteBeforeHandler } from "./plugin/tool-execute-before"
import { showSkillSecurityNotice } from "./plugin/skill-security-notice"

import type { CreatedHooks } from "./create-hooks"
import type { Managers } from "./create-managers"
import { AutopilotError, isAutopilotAgent, isAutopilotTranscript, type AutopilotRuntime } from "./features/autopilot"
import { getAgentDisplayName } from "./shared/agent-display-names"
import { normalizeSDKResponse } from "./shared/normalize-sdk-response"

export function createPluginInterface(args: {
  autopilotRuntime?: AutopilotRuntime
  ctx: PluginContext
  pluginConfig: OhMyOpenCodeConfig
  firstMessageVariantGate: {
    shouldOverride: (sessionID: string) => boolean
    markApplied: (sessionID: string) => void
    markSessionCreated: (sessionInfo: { id?: string; title?: string; parentID?: string } | undefined) => void
    clear: (sessionID: string) => void
  }
  managers: Managers
  hooks: CreatedHooks
  tools: ToolsRecord
}): PluginInterface {
  const { ctx, pluginConfig, firstMessageVariantGate, managers, hooks, tools } =
    args
  const runtime = args.autopilotRuntime
  const nativeName = getAgentDisplayName("autopilot", pluginConfig.agents)
  const isNamedAutopilot = (agent: unknown) => isAutopilotAgent(agent) || agent === nativeName
    || (agent !== null && typeof agent === "object" && "name" in agent && agent.name === nativeName)
  const guard = async (sessionID: string, agent?: unknown) => {
    if (runtime) return await runtime.guardSession(sessionID, agent) ? runtime : undefined
    if (isNamedAutopilot(agent)) throw new AutopilotError("runtime_unavailable")
    if (sessionID && typeof ctx.client?.session?.messages === "function") {
      const response = await ctx.client.session.messages({ path: { id: sessionID } })
      const messages = normalizeSDKResponse(response, [] as { info?: { agent?: string } }[])
      if (isAutopilotTranscript(messages, isNamedAutopilot)) throw new AutopilotError("runtime_unavailable")
    }
    return undefined
  }
  const chat = createChatMessageHandler({ ctx, pluginConfig, firstMessageVariantGate, hooks })
  const command = createCommandExecuteBeforeHandler({ directory: ctx.directory, hooks,
    mcpManager: managers.skillMcpManager, notify: message => showSkillSecurityNotice(ctx, message) })
  const messages = createMessagesTransformHandler({ hooks })
  const system = createSystemTransformHandler(pluginConfig.default_mode, getUltraworkMessage, hooks.keywordDetector)
  const event = createEventHandler({ ctx, pluginConfig, firstMessageVariantGate, managers, hooks })
  const before = createToolExecuteBeforeHandler({ ctx, hooks, backgroundManager: managers.backgroundManager,
    isAutopilotTarget: agent => isNamedAutopilot(agent) || runtime?.isAutopilotName(agent) === true })
  const after = createToolExecuteAfterHandler({ ctx, hooks })

  return {
    tool: tools,

    "chat.params": async (input: unknown, output: unknown) => {
      const chatParamsInput = input as {
        sessionID: string
        agent?: string | { name?: string }
        model?: { providerID?: unknown; modelID?: unknown; id?: unknown }
        message?: { variant?: string }
      }
      const childRuntime = await guard(chatParamsInput.sessionID, chatParamsInput.agent)
      if (childRuntime) {
        await childRuntime.params(input, output)
        return
      }
      const agentName =
        typeof chatParamsInput.agent === "string"
          ? chatParamsInput.agent
          : chatParamsInput.agent?.name
      const providerID = chatParamsInput.model?.providerID
      const rawModelID = chatParamsInput.model?.modelID ?? chatParamsInput.model?.id
      const modelID = typeof rawModelID === "string" ? rawModelID : undefined
      if (chatParamsInput.message && typeof providerID === "string" && modelID !== undefined) {
        applyAgentVariant(pluginConfig, agentName, chatParamsInput.message, { providerID, modelID })
      }
      const handler = createChatParamsHandler({
        client: ctx.client,
      })
      await handler(input, output)
    },

    "chat.headers": createChatHeadersHandler({ ctx }),

    "command.execute.before": async (input, output) => {
      if (await guard(input.sessionID)) throw new AutopilotError("tool_forbidden")
      await command(input, output)
    },
    "chat.message": async (input, output) => {
      const childRuntime = await guard(input.sessionID, input.agent)
      if (childRuntime) { childRuntime.chat(input, output); return }
      await chat(input, output)
    },
    "experimental.chat.messages.transform": async (input, output) => {
      if (runtime) {
        for (const message of output.messages) {
          const info = message.info as { sessionID?: string; agent?: string }
          if (info.sessionID && (runtime.ownsChild(info.sessionID) || runtime.isAutopilotName(info.agent))) await guard(info.sessionID, info.agent)
        }
        if (runtime.messages(output)) return
      }
      else if (isAutopilotTranscript(output.messages, isNamedAutopilot)) {
        throw new AutopilotError("runtime_unavailable")
      }
      await messages(input, output)
    },
    "experimental.chat.system.transform": async (input, output) => {
      const childRuntime = await guard(input.sessionID ?? "")
      if (childRuntime) { childRuntime.system(input, output); return }
      await system(input, output)
    },

    config: managers.configHandler,

    event: async input => {
      if (runtime?.event(input.event as { type: string; properties?: Record<string, unknown> })) return
      await event(input)
    },

    "tool.definition": createToolDefinitionHandler({
      hooks,
    }),

    "tool.execute.before": async (input, output) => {
      const childRuntime = await guard(input.sessionID)
      if (childRuntime) { await childRuntime.tool(input.sessionID, input.tool, output.args); return }
      await before(input, output)
    },
    "tool.execute.after": async (input, output) => {
      if (runtime?.ownsChild(input.sessionID)) return
      await after(input, output)
    },
  }
}
