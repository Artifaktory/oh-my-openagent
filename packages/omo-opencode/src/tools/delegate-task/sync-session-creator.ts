import type { OpencodeClient } from "./types"
import type { DelegatedModelConfig } from "../../shared/model-resolution-types"
import { QUESTION_DENIED_SESSION_PERMISSION } from "../../shared/question-denied-session-permission"
import type { SyncExecutionControl } from "./sync-admission"

export async function createSyncSession(
  client: OpencodeClient,
  input: {
    parentSessionID: string
    agentToUse: string
    description: string
    defaultDirectory: string
    category?: string
    categoryModel?: DelegatedModelConfig
    control?: SyncExecutionControl
    ownedPermissions?: readonly { permission: string; pattern: string; action: "allow" | "deny" | "ask" }[]
  }
): Promise<{ ok: true; sessionID: string; parentDirectory: string } | { ok: false; error: string }> {
  input.control?.check()
  const parentSession = await client.session.get({ path: { id: input.parentSessionID },
    ...(input.control ? { signal: input.control.signal } : {}) }).catch(() => null)
  input.control?.check()
  const parentDirectory = parentSession?.data?.directory ?? input.defaultDirectory

  input.control?.check()
  const createResult = await client.session.create({
    ...(input.control ? { signal: input.control.signal } : {}),
    body: {
      parentID: input.parentSessionID,
      title: `${input.category ? `[${input.category}] ` : ""}${input.description} (@${input.agentToUse} subagent)`,
      permission: input.ownedPermissions ?? QUESTION_DENIED_SESSION_PERMISSION,
      ...(input.categoryModel
        ? {
            model: {
              id: input.categoryModel.modelID,
              providerID: input.categoryModel.providerID,
              ...(input.categoryModel.variant ? { variant: input.categoryModel.variant } : {}),
            },
          }
        : {}),
    } as Record<string, unknown>,
    query: {
      directory: parentDirectory,
    },
  })

  if (createResult.error !== undefined) {
    return { ok: false, error: `Failed to create session: ${createResult.error}` }
  }
  if (createResult.data === undefined) {
    return { ok: false, error: "Failed to create session: missing session data" }
  }

  return { ok: true, sessionID: createResult.data.id, parentDirectory }
}
