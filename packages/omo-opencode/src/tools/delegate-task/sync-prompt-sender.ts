import type { SisyphusAgentConfig } from "../../config/schema"
import { stripInvisibleAgentCharacters } from "../../shared/agent-display-names"
import { getAgentToolRestrictions } from "../../shared/agent-tool-restrictions"
import { createInternalAgentTextPart } from "../../shared/internal-initiator-marker"
import {
  promptWithModelSuggestionRetry,
} from "../../shared/model-suggestion-retry"
import { migrateToolsToPermission } from "../../shared/permission-compat"
import { applySessionPromptParams } from "../../shared/session-prompt-params-helpers"
import { routePromptRetry } from "../../shared/session-route"
import { setSessionTools } from "../../shared/session-tools-store"
import { isPlanFamily } from "./constants"
import { formatDetailedError } from "./error-formatting"
import { buildTaskPrompt } from "./prompt-builder"
import type { DelegatedModelConfig, DelegateTaskArgs, OpencodeClient } from "./types"
import type { SyncExecutionControl } from "./sync-admission"
import { dispatchInternalPrompt } from "../../shared/prompt-async-gate"
import { shouldRetryError } from "../../shared/model-error-classifier"

type SendSyncPromptDeps = {
  promptWithModelSuggestionRetry: typeof promptWithModelSuggestionRetry
  dispatchInternalPrompt?: typeof dispatchInternalPrompt
}

const sendSyncPromptDeps: SendSyncPromptDeps = {
  promptWithModelSuggestionRetry,
}

function buildPromptGenerationParams(model: DelegatedModelConfig | undefined): Record<string, unknown> {
  if (!model) {
    return {}
  }

  const promptOptions: Record<string, unknown> = {
    ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
    ...(model.thinking ? { thinking: model.thinking } : {}),
  }

  return {
    ...(model.temperature !== undefined ? { temperature: model.temperature } : {}),
    ...(model.top_p !== undefined ? { topP: model.top_p } : {}),
    ...(model.maxTokens !== undefined ? { maxOutputTokens: model.maxTokens } : {}),
    ...(Object.keys(promptOptions).length > 0 ? { options: promptOptions } : {}),
  }
}

function isOracleAgent(agentToUse: string): boolean {
  return stripInvisibleAgentCharacters(agentToUse).toLowerCase() === "oracle"
}

function isUnexpectedEofError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  const lowered = message.toLowerCase()
  return lowered.includes("unexpected eof") || lowered.includes("json parse error")
}

function retryableNativeError(error: unknown): boolean {
  if (error instanceof Error) return shouldRetryError({ name: error.name, message: error.message })
  if (typeof error === "string") return shouldRetryError({ message: error })
  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>
    return shouldRetryError({ ...(typeof record.name === "string" ? { name: record.name } : {}),
      ...(typeof record.message === "string" ? { message: record.message } : {}),
      ...(typeof record.statusCode === "number" ? { statusCode: record.statusCode } : {}) })
  }
  return false
}

export function buildSyncPromptTools(
  agentToUse: string,
  permission?: Record<string, "ask" | "allow" | "deny">,
): Record<string, boolean> {
  const userDenied: Record<string, boolean> = {}
  if (permission) {
    for (const [tool, value] of Object.entries(permission)) {
      if (value === "deny") userDenied[tool] = false
    }
  }
  return {
    task: isPlanFamily(agentToUse),
    call_omo_agent: true,
    question: false,
    ...userDenied,
    ...getAgentToolRestrictions(agentToUse),
  }
}

export async function sendSyncPrompt(
  client: OpencodeClient,
  input: {
    sessionID: string
    agentToUse: string
    args: DelegateTaskArgs
    systemContent: string | undefined
    categoryModel: DelegatedModelConfig | undefined
    directory: string
    toastManager: { removeTask: (id: string) => void } | null | undefined
    taskId: string | undefined
    sisyphusAgentConfig?: SisyphusAgentConfig
    control?: SyncExecutionControl
    ownedPrompt?: { readonly messageID: string; readonly tools: Readonly<Record<string, boolean>> }
  },
  deps: SendSyncPromptDeps = sendSyncPromptDeps
): Promise<string | null> {
  const tddEnabled = input.sisyphusAgentConfig?.tdd
  input.control?.check()
  const effectivePrompt = input.ownedPrompt ? input.args.prompt : buildTaskPrompt(input.args.prompt, input.agentToUse, tddEnabled)
  const userPermission = input.categoryModel?.tools
    ? migrateToolsToPermission(input.categoryModel.tools)
    : undefined
  const tools = input.ownedPrompt ? { ...input.ownedPrompt.tools } : buildSyncPromptTools(input.agentToUse, userPermission)
  setSessionTools(input.sessionID, tools)

  const loweredReasoning = applySessionPromptParams(input.sessionID, input.categoryModel)
  const promptModel = input.categoryModel?.reasoning !== undefined
    ? { ...input.categoryModel, reasoningEffort: loweredReasoning.reasoningEffort }
    : input.categoryModel
  const promptVariant = input.categoryModel?.reasoning !== undefined
    ? loweredReasoning.variant
    : input.categoryModel?.variant

  const promptArgs = {
    ...(input.control ? { signal: input.control.signal } : {}),
    path: { id: input.sessionID },
    body: {
      agent: stripInvisibleAgentCharacters(input.agentToUse),
      system: input.systemContent,
      tools,
      parts: [createInternalAgentTextPart(effectivePrompt)],
      ...(input.ownedPrompt ? { messageID: input.ownedPrompt.messageID } : {}),
      ...(input.categoryModel
        ? {
            model: {
              providerID: input.categoryModel.providerID,
              modelID: input.categoryModel.modelID,
            },
          }
        : {}),
      ...(promptVariant ? { variant: promptVariant } : {}),
      ...buildPromptGenerationParams(promptModel),
    },
  }

  try {
    if (input.control) {
      const control = input.control
      control.check()
      const result = await (deps.dispatchInternalPrompt ?? dispatchInternalPrompt)({
        mode: "async", client, sessionID: input.sessionID,
        input: routePromptRetry(promptArgs, input.directory), source: "task-sync-controlled",
        queueBehavior: "defer", durableRetry: false, dispatchTimeoutMs: control.remaining(),
        shouldDispatch: () => { try { control.check(); return true } catch { return false } },
      })
      control.check()
      if (result.status !== "dispatched") return "error" in result && retryableNativeError(result.error)
        ? "Retryable native model unavailable; captured fallback eligible" : "Autopilot native dispatch was not accepted"
      return null
    }
    await deps.promptWithModelSuggestionRetry(client, routePromptRetry(promptArgs, input.directory), {
      queueBehavior: "defer",
      checkStatus: false,
      checkToolState: false,
    })
  } catch (promptError) {
    if (input.ownedPrompt) return retryableNativeError(promptError)
      ? "Retryable native model unavailable; captured fallback eligible" : "Autopilot native dispatch failed"
    if (isOracleAgent(input.agentToUse) && isUnexpectedEofError(promptError)) {
      return null
    }

    if (input.toastManager && input.taskId !== undefined) {
      input.toastManager.removeTask(input.taskId)
    }
    const errorMessage = promptError instanceof Error ? promptError.message : String(promptError)
    if (errorMessage.includes("agent.name") || errorMessage.includes("undefined")) {
      return formatDetailedError(new Error(`Agent "${input.agentToUse}" not found. Make sure the agent is registered in your opencode.json or provided by a plugin.`), {
        operation: "Send prompt to agent",
        args: input.args,
        sessionID: input.sessionID,
        agent: input.agentToUse,
        category: input.args.category,
      })
    }
    return formatDetailedError(promptError, {
      operation: "Send prompt",
      args: input.args,
      sessionID: input.sessionID,
      agent: input.agentToUse,
      category: input.args.category,
    })
  }

  return null
}
