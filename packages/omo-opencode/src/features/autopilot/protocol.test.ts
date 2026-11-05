import { describe, expect, test } from "bun:test"
import { captureGateRequest, sha256, validateModelDecision } from "./protocol"

function requestInput() {
  const digest = "a".repeat(64)
  return {
    protocol: "autopilot.gate-request.v1", invocation_id: "inv-1", created_at: 1000, deadline: 2000,
    action: "task_update.completed_revision",
    host: { workspace: "workspace", worktree: "worktree", parent_session_id: "parent", tool_call_id: "call", caller_session_id: "parent", caller_agent: "sisyphus" },
    task: { store: "store", id: "task-1", origin_thread_id: "parent", lineage: "same_workspace", pre_image_revision: "revision-1",
      pre_image_digest: digest, post_image_digest: digest, update_arguments: { status: "completed", metadata: { check: "artifact" } } },
    subject: { identity: "subject", revision: "head", digest },
    evidence: [{ id: "check", source: "enrolled-artifact", sha256: sha256("artifact"), content: "artifact", captured_at: 900, expires_at: 2000, disposition: "enrolled" }],
    options: [{ id: "complete", action: "complete_exact_post_image", post_image_digest: digest }, { id: "operator", action: "return_to_operator" }],
    policy: { revision: "publication-1", manifest_digest: digest, policy_digest: digest, instruction_digest: digest, configuration_digest: digest },
    models: [{ providerID: "operator", modelID: "selected", reasoning: "high" }],
    dispatch: { providerID: "operator", modelID: "selected", reasoning: "high" }, permission_ceiling: [],
  }
}

function decisionInput() {
  const { request, digest } = captureGateRequest(requestInput(), 1000)
  return { request, decision: { protocol: "autopilot.model-decision.v1", invocation_id: request.invocation_id,
    request_digest: digest, outcome: "approve", reason_codes: ["checks_satisfied"], evidence_ids: ["check"], explanation: "assessment" } }
}

describe("Autopilot request and decision protocol", () => {
  test("captures independent immutable arguments and canonical object identities", () => {
    // given
    const input = requestInput()
    const captured = captureGateRequest(input, 1000)
    // when
    input.task.update_arguments.metadata.check = "changed"
    input.evidence[0].content = "changed"
    // then
    expect(captured.request.task.update_arguments.metadata).toEqual({ check: "artifact" })
    expect(captured.request.evidence[0].content).toBe("artifact")
    expect(Object.isFrozen(captured.request.task.update_arguments.metadata)).toBe(true)
    const reordered = Object.fromEntries(Object.entries(requestInput()).reverse())
    expect(captureGateRequest(reordered, 1000).digest).toBe(captured.digest)
    expect(captureGateRequest(input, 1000).digest).not.toBe(captured.digest)
  })

  for (const outcome of ["approve", "rework", "select_option", "human_required"]) {
    test(`validates ${outcome} with its scoped references`, () => {
      // given
      const { request, decision } = decisionInput()
      // when
      const result = validateModelDecision({ ...decision, outcome, ...(outcome === "select_option" ? { option_id: "complete" } : {}) }, request, 1500)
      // then
      expect(result.outcome).toBe(outcome)
      expect(Object.isFrozen(result)).toBe(true)
    })
  }

  test("rejects unsupported action, widened ceiling, deadlines, extra authority and conflicting options", () => {
    // given
    const input = requestInput()
    const invalid = [
      { ...input, trusted: true }, { ...input, action: "merge" }, { ...input, permission_ceiling: ["bash"] },
      { ...input, deadline: 121001 }, { ...input, models: [{ providerID: "other", modelID: "other" }] },
      { ...input, options: [...input.options, input.options[0]] },
      { ...input, options: [{ ...input.options[0], post_image_digest: "b".repeat(64) }] },
    ]
    // when / then
    for (const value of invalid) expect(() => captureGateRequest(value, 1000)).toThrow("invalid_request")
    expect(() => captureGateRequest({ ...input, unknown: "x".repeat(262144) }, 1000)).toThrow("invalid_request")
  })

  test("rejects malformed text, forged bindings, unknown references and option misuse", () => {
    // given
    const { request, decision } = decisionInput()
    const invalid = [
      "```json\n{}\n```", { ...decision, trusted: true }, { ...decision, invocation_id: "other" },
      { ...decision, request_digest: "f".repeat(64) }, { ...decision, evidence_ids: ["invented"] },
      { ...decision, outcome: "select_option", option_id: "invented" }, { ...decision, option_id: "complete" },
      { ...decision, explanation: "x".repeat(4097) }, { ...decision, evidence_ids: ["check", "check"] },
    ]
    // when / then
    for (const value of invalid) expect(() => validateModelDecision(value, request, 1500)).toThrow()
  })

  test("unresolved lineage and stale, unavailable or altered evidence cannot complete", () => {
    // given
    const inputs = [requestInput(), requestInput(), requestInput(), requestInput()]
    inputs[0].task.lineage = "unresolved"
    inputs[1].evidence[0].expires_at = 1400
    inputs[2].evidence[0].disposition = "unestablished"
    inputs[3].evidence[0].content = "tampered"
    // when / then
    for (const input of inputs) {
      const { request, digest } = captureGateRequest(input, 1000)
      const decision = { ...decisionInput().decision, request_digest: digest }
      expect(() => validateModelDecision(decision, request, 1500)).toThrow()
      expect(() => validateModelDecision({ ...decision, outcome: "select_option", option_id: "complete" }, request, 1500)).toThrow()
      expect(validateModelDecision({ ...decision, outcome: "human_required" }, request, 1500).outcome).toBe("human_required")
    }
  })

  test("cancellation and deadline invalidate even non-completion model results", () => {
    // given
    const { request, decision } = decisionInput()
    const abort = new AbortController()
    // when
    abort.abort()
    // then
    expect(() => validateModelDecision(decision, request, 1500, abort.signal)).toThrow("request_cancelled")
    expect(() => validateModelDecision(decision, request, 2000)).toThrow("request_expired")
    expect(() => captureGateRequest(requestInput(), 2000)).toThrow("request_expired")
  })
})
