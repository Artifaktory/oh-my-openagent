import { freezeSnapshot, sha256, canonicalJson } from "./protocol"
import type { GateRequest, ModelDecision } from "./types"
import type { NativeFinalResult } from "../../tools/delegate-task/sync-result-fetcher"
import type { OwnedAutopilotChild } from "./child-registry"

declare const receiptBrand: unique symbol
export interface DecisionReceipt {
  readonly [receiptBrand]: true
  readonly invocation_id: string
  readonly request_digest: string
  readonly decision: ModelDecision
  readonly scope: { readonly host: GateRequest["host"]; readonly task: GateRequest["task"]; readonly subject: GateRequest["subject"]
    readonly evidence: readonly { readonly id: string; readonly source: string; readonly sha256: string }[]; readonly deadline: number }
  readonly provenance: { readonly child_session_id: string; readonly final_message_id: string; readonly prompt_message_id: string
    readonly agent: "autopilot"; readonly native_agent: string; readonly provider_id: string; readonly model_id: string; readonly reasoning: string | null
    readonly parameters_digest: string; readonly fallback_attempt: number }
  readonly bindings: { readonly subject: string; readonly action: string; readonly evidence: string; readonly policy: GateRequest["policy"]
    readonly authority: string }
  readonly created_at: number
  readonly completed_at: number
  readonly effect: { readonly task_store_commit: "not_attempted"; readonly todo_projection: "not_attempted" }
}

/** Each runtime owns this ledger. Serialized objects and receipts from another runtime cannot pass it. */
export function createReceiptLedger() {
  const issued = new WeakSet<object>()
  return {
    issue(request: GateRequest, decision: ModelDecision, final: NativeFinalResult, child: OwnedAutopilotChild, authority: string): DecisionReceipt {
      const receipt = freezeSnapshot({ invocation_id: request.invocation_id, request_digest: sha256(canonicalJson(request)), decision,
        scope: { host: request.host, task: request.task, subject: request.subject,
          evidence: request.evidence.map(({ id, source, sha256: digest }) => ({ id, source, sha256: digest })), deadline: request.deadline },
        provenance: { child_session_id: final.sessionID, final_message_id: final.messageID, prompt_message_id: final.parentMessageID,
          agent: final.agent, native_agent: final.nativeAgent, provider_id: final.providerID, model_id: final.modelID, reasoning: child.observed.reasoning ?? null,
          parameters_digest: sha256(child.observed.parameters ?? ""), fallback_attempt: child.attempt },
        bindings: { subject: request.subject.digest, action: sha256(canonicalJson(request.task)),
          evidence: sha256(canonicalJson(request.evidence)), policy: request.policy, authority },
        created_at: request.created_at, completed_at: final.completedAt,
        effect: { task_store_commit: "not_attempted", todo_projection: "not_attempted" } }) as DecisionReceipt
      issued.add(receipt)
      return receipt
    },
    owns(value: unknown): value is DecisionReceipt { return value !== null && typeof value === "object" && issued.has(value) },
  }
}
