import type { z } from "zod"
import type { GateRequestSchema, ModelDecisionSchema } from "./protocol"
import type { PolicyManifestSchema, PolicySourceSchema } from "./policy-schema"

export type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? ReadonlyArray<DeepReadonly<Item>>
  : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T
export type GateRequest = DeepReadonly<z.infer<typeof GateRequestSchema>>
export type ModelDecision = DeepReadonly<z.infer<typeof ModelDecisionSchema>>
export type PolicyManifest = DeepReadonly<z.infer<typeof PolicyManifestSchema>>
export type PolicySource = DeepReadonly<z.infer<typeof PolicySourceSchema>>

export type AutopilotErrorCode =
  | "invalid_request" | "invalid_decision" | "invalid_manifest" | "invalid_configuration"
  | "request_expired" | "request_cancelled" | "decision_mismatch" | "evidence_unavailable"
  | "lineage_unresolved" | "source_unenrolled" | "source_forbidden" | "source_unavailable"
  | "source_changed" | "source_too_large" | "invalid_utf8" | "policy_mismatch"
  | "unowned_child" | "child_reuse" | "tool_forbidden" | "context_unverified"
  | "runtime_unavailable" | "background_unsupported" | "native_result_invalid" | "authority_revoked"

export class AutopilotError extends Error {
  constructor(readonly code: AutopilotErrorCode) {
    super(code)
    this.name = "AutopilotError"
  }
}

export interface CapturedPolicyFile {
  readonly path: string
  readonly identity: string
  readonly sha256: string
  readonly byteLength: number
  readonly text: string
}

export interface CapturedPolicySource {
  readonly descriptor: PolicySource
  readonly file?: CapturedPolicyFile
  readonly text: string
}

export interface PolicySnapshot {
  readonly manifest: PolicyManifest
  readonly manifestDigest: string
  readonly policyDigest: string
  readonly configurationDigest: string
  readonly sources: readonly CapturedPolicySource[]
}

export interface InstructionSnapshot {
  readonly text: string
  readonly digest: string
  readonly manifestDigest: string
  readonly policyDigest: string
  readonly configurationDigest: string
  readonly compositionVersion: "1"
}
