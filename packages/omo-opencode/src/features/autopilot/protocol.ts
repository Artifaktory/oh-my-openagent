import { createHash } from "node:crypto"
import { z } from "zod"
import { AutopilotError, type DeepReadonly, type GateRequest, type ModelDecision } from "./types"

export const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/)
export const IdentifierSchema = z.string().min(1).max(256)
const ModelSchema = z.strictObject({ providerID: IdentifierSchema, modelID: IdentifierSchema, reasoning: IdentifierSchema.optional() })
const EvidenceSchema = z.strictObject({
  id: IdentifierSchema, source: IdentifierSchema, sha256: DigestSchema,
  captured_at: z.number().int().nonnegative(), expires_at: z.number().int().nonnegative(),
  disposition: z.enum(["enrolled", "unavailable", "unestablished"]),
  content: z.string().max(65536),
})
const OptionSchema = z.discriminatedUnion("action", [
  z.strictObject({ id: IdentifierSchema, action: z.literal("complete_exact_post_image"), post_image_digest: DigestSchema }),
  z.strictObject({ id: IdentifierSchema, action: z.literal("rework"), category: IdentifierSchema }),
  z.strictObject({ id: IdentifierSchema, action: z.literal("return_to_operator") }),
])

export const GateRequestSchema = z.strictObject({
  protocol: z.literal("autopilot.gate-request.v1"), invocation_id: IdentifierSchema,
  created_at: z.number().int().nonnegative(), deadline: z.number().int().nonnegative(),
  action: z.literal("task_update.completed_revision"),
  host: z.strictObject({ workspace: IdentifierSchema, worktree: IdentifierSchema, parent_session_id: IdentifierSchema,
    tool_call_id: IdentifierSchema, caller_session_id: IdentifierSchema, caller_agent: IdentifierSchema }),
  task: z.strictObject({ store: IdentifierSchema, id: IdentifierSchema, origin_thread_id: IdentifierSchema,
    lineage: z.enum(["same_workspace", "unresolved", "cross_workspace"]),
    pre_image_revision: IdentifierSchema, pre_image_digest: DigestSchema, post_image_digest: DigestSchema,
    update_arguments: z.record(z.string(), z.json()) }),
  subject: z.strictObject({ identity: IdentifierSchema, revision: IdentifierSchema, digest: DigestSchema }),
  evidence: z.array(EvidenceSchema).min(1).max(32), options: z.array(OptionSchema).min(1).max(16),
  policy: z.strictObject({ revision: IdentifierSchema, manifest_digest: DigestSchema, policy_digest: DigestSchema,
    instruction_digest: DigestSchema, configuration_digest: DigestSchema }),
  models: z.array(ModelSchema).min(1).max(2), dispatch: ModelSchema,
  permission_ceiling: z.array(z.enum(["read", "glob", "grep"])).max(3),
})

export const ModelDecisionSchema = z.strictObject({
  protocol: z.literal("autopilot.model-decision.v1"), invocation_id: IdentifierSchema, request_digest: DigestSchema,
  outcome: z.enum(["approve", "rework", "select_option", "human_required"]), option_id: IdentifierSchema.optional(),
  reason_codes: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)).min(1).max(16),
  evidence_ids: z.array(IdentifierSchema).max(32), explanation: z.string().min(1).max(4096),
})

export function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

export function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 32) throw new AutopilotError("invalid_request")
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value)
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item, depth + 1)).join(",")}]`
  if (typeof value === "object" && value && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => {
      if (["__proto__", "constructor", "prototype"].includes(key)) throw new AutopilotError("invalid_request")
      return `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key], depth + 1)}`
    }).join(",")}}`
  }
  throw new AutopilotError("invalid_request")
}

export function freezeSnapshot<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freezeSnapshot(item)
    Object.freeze(value)
  }
  return value as DeepReadonly<T>
}

function parseWire(input: unknown, limit: number, code: "invalid_request" | "invalid_decision"): unknown {
  try {
    const json = typeof input === "string" ? input : canonicalJson(input)
    if (Buffer.byteLength(json) > limit) throw new Error()
    const parsed: unknown = JSON.parse(json)
    canonicalJson(parsed)
    return parsed
  } catch { throw new AutopilotError(code) }
}

function assertRequestActive(request: GateRequest, now: number, signal?: AbortSignal): void {
  if (signal?.aborted) throw new AutopilotError("request_cancelled")
  if (now < request.created_at || now >= request.deadline) throw new AutopilotError("request_expired")
}

// This binds request data. Host provenance and receipt authority belong to the runtime-owned producer.
export function captureGateRequest(input: unknown, now = Date.now(), signal?: AbortSignal): { readonly request: GateRequest; readonly digest: string } {
  const parsed = GateRequestSchema.safeParse(parseWire(input, 262144, "invalid_request"))
  if (!parsed.success) throw new AutopilotError("invalid_request")
  const request = parsed.data
  if (request.deadline <= request.created_at || request.deadline - request.created_at > 120000
    || new Set(request.evidence.map(item => item.id)).size !== request.evidence.length
    || new Set(request.options.map(item => item.id)).size !== request.options.length
    || new Set(request.permission_ceiling).size !== request.permission_ceiling.length
    || !request.models.some(model => canonicalJson(model) === canonicalJson(request.dispatch))
    || request.options.some(option => option.action === "complete_exact_post_image" && option.post_image_digest !== request.task.post_image_digest)) {
    throw new AutopilotError("invalid_request")
  }
  assertRequestActive(request, now, signal)
  return Object.freeze({ request: freezeSnapshot(request), digest: sha256(canonicalJson(request)) })
}

export function validateModelDecision(input: unknown, request: GateRequest, now = Date.now(), signal?: AbortSignal): ModelDecision {
  assertRequestActive(request, now, signal)
  const parsed = ModelDecisionSchema.safeParse(parseWire(input, 16384, "invalid_decision"))
  if (!parsed.success) throw new AutopilotError("invalid_decision")
  const decision = parsed.data
  if (decision.invocation_id !== request.invocation_id || decision.request_digest !== sha256(canonicalJson(request))
    || new Set(decision.evidence_ids).size !== decision.evidence_ids.length
    || decision.evidence_ids.some(id => !request.evidence.some(item => item.id === id))) throw new AutopilotError("decision_mismatch")
  const option = request.options.find(item => item.id === decision.option_id)
  if ((decision.outcome === "select_option" && !option) || (decision.outcome !== "select_option" && decision.option_id !== undefined)) {
    throw new AutopilotError("invalid_decision")
  }
  const completion = decision.outcome === "approve" || option?.action === "complete_exact_post_image"
  if (completion) {
    if (!request.options.some(item => item.action === "complete_exact_post_image")) throw new AutopilotError("decision_mismatch")
    if (request.task.lineage !== "same_workspace") throw new AutopilotError("lineage_unresolved")
    if (request.evidence.some(item => item.disposition !== "enrolled" || item.captured_at > now || item.expires_at <= now
      || sha256(item.content) !== item.sha256)) throw new AutopilotError("evidence_unavailable")
  }
  return freezeSnapshot(decision)
}
