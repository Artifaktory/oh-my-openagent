import path from "node:path"
import { realpath } from "node:fs/promises"
import { z } from "zod"
import { TaskObjectSchema } from "../../tools/task/types"
import type { OpencodeClient, ToolContextWithMetadata } from "../../tools/delegate-task/types"
import type { AutopilotBinding } from "./authority"
import { readPolicyFile } from "./policy-file-reader"
import { canonicalJson, freezeSnapshot, sha256, validateModelDecision } from "./protocol"
import { AutopilotError, type GateRequest } from "./types"
import type { NativeFinalResult } from "../../tools/delegate-task/sync-result-fetcher"

const reference = z.string().min(1).max(2048)
const AssessmentSchema = z.strictObject({
  protocol: z.literal("autopilot.assessment.v1"),
  task: z.strictObject({ store: reference, id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) }),
  subject: z.strictObject({ path: reference }),
  evidence: z.array(z.strictObject({ id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/), path: reference })).min(1).max(30),
})
export type AssessmentInput = z.infer<typeof AssessmentSchema>

export function captureAssessment(input: string): Readonly<AssessmentInput> {
  if (Buffer.byteLength(input) > 16384) throw new AutopilotError("invalid_request")
  try {
    const parsed = AssessmentSchema.parse(JSON.parse(input))
    if (new Set(parsed.evidence.map(item => item.id)).size !== parsed.evidence.length) throw Error()
    return freezeSnapshot(parsed) as Readonly<AssessmentInput>
  } catch { throw new AutopilotError("invalid_request") }
}

export interface HostAssessment {
  readonly task: GateRequest["task"]
  readonly subject: GateRequest["subject"]
  readonly evidence: GateRequest["evidence"]
  readonly options: GateRequest["options"]
}

/** The operator enrolls roots; the host reads the facts. Public hashes and flags are never inputs. */
export async function captureHostAssessment(input: {
  readonly assessment: Readonly<AssessmentInput>; readonly binding: AutopilotBinding
  readonly context: ToolContextWithMetadata; readonly client: OpencodeClient; readonly deadline: number
  readonly check: () => void
}): Promise<HostAssessment> {
  const { assessment, binding, context, client, deadline, check } = input
  const enrollment = binding.enrollment
  if (binding.state !== "enabled" || !enrollment) throw new AutopilotError("invalid_configuration")
  check()
  const file = await readPolicyFile(path.join(assessment.task.store, `${assessment.task.id}.json`), {
    directory: binding.workspace, roots: enrollment.task_store_roots, maxFileBytes: binding.limits.max_file_bytes,
  })
  let task: z.infer<typeof TaskObjectSchema>
  try { task = TaskObjectSchema.parse(JSON.parse(file.text)) } catch { throw new AutopilotError("invalid_request") }
  if (task.id !== assessment.task.id || task.status === "deleted") throw new AutopilotError("invalid_request")
  let sessionID: string | undefined = context.sessionID
  const visited = new Set<string>()
  let lineage = false
  while (sessionID && visited.size < 32 && !visited.has(sessionID)) {
    check()
    visited.add(sessionID)
    const session = await client.session.get({ path: { id: sessionID }, signal: context.abort })
    check()
    if (session.error || !session.data?.directory
      || path.relative(await realpath(session.data.directory), binding.workspace) !== "") break
    if (sessionID === task.threadID) { lineage = true; break }
    sessionID = session.data.parentID
  }
  if (!lineage) throw new AutopilotError("lineage_unresolved")
  const scope = { directory: binding.workspace, roots: enrollment.evidence_roots, maxFileBytes: binding.limits.max_file_bytes }
  const subject = await readPolicyFile(assessment.subject.path, scope)
  const captured = [{ id: "_task", file }, { id: "_subject", file: subject }]
  let total = file.byteLength + subject.byteLength
  for (const item of assessment.evidence) {
    check()
    const evidence = await readPolicyFile(item.path, scope)
    total += evidence.byteLength
    if (total > binding.limits.max_total_bytes) throw new AutopilotError("source_too_large")
    captured.push({ id: item.id, file: evidence })
  }
  check()
  const post = { ...task, status: "completed" }
  const preDigest = sha256(canonicalJson(task))
  const postDigest = sha256(canonicalJson(post))
  const now = Date.now()
  return freezeSnapshot({
    task: { store: path.dirname(file.path), id: task.id, origin_thread_id: task.threadID, lineage: "same_workspace",
      pre_image_revision: file.sha256, pre_image_digest: preDigest, post_image_digest: postDigest,
      update_arguments: { id: task.id, status: "completed" } },
    subject: { identity: subject.path, revision: subject.sha256, digest: subject.sha256 },
    evidence: captured.map(({ id, file: current }) => ({ id, source: current.path, sha256: current.sha256,
      captured_at: now, expires_at: deadline, disposition: "enrolled", content: current.text })),
    options: [{ id: "complete", action: "complete_exact_post_image", post_image_digest: postDigest },
      { id: "rework", action: "rework", category: "required_evidence" }, { id: "operator", action: "return_to_operator" }],
  })
}

export function validateNativeDecision(final: NativeFinalResult, request: GateRequest, signal: AbortSignal) {
  if (final.agent !== "autopilot" || final.providerID !== request.dispatch.providerID || final.modelID !== request.dispatch.modelID
    || final.completedAt < request.created_at || final.completedAt > Date.now()) throw new AutopilotError("decision_mismatch")
  return validateModelDecision(final.text, request, Date.now(), signal)
}
