import { describe, expect, test } from "bun:test"
import { captureAssessment } from "./decision-validation"

describe("public assessment input boundary", () => {
  const input = { protocol: "autopilot.assessment.v1", task: { store: "tasks", id: "task1" }, subject: { path: "evidence/subject.md" },
    evidence: [{ id: "check", path: "evidence/check.json" }] }
  test("#given file references #when captured #then caller objects cannot mutate the frozen request", () => {
    const captured = captureAssessment(JSON.stringify(input))
    expect(captured).toEqual(input)
    expect(Object.isFrozen(captured.evidence[0])).toBe(true)
  })
  test("#given caller attestation or altered action #when parsed #then no host facts are accepted", () => {
    for (const addition of [{ verified: true }, { authority: "operator" }, { action: "task_update" }, { request_digest: "a".repeat(64) }]) {
      expect(() => captureAssessment(JSON.stringify({ ...input, ...addition }))).toThrow("invalid_request")
    }
    expect(() => captureAssessment(JSON.stringify({ ...input, evidence: [input.evidence[0], input.evidence[0]] }))).toThrow("invalid_request")
    expect(() => captureAssessment(JSON.stringify({ ...input, task: { store: "tasks", id: "../outside" } }))).toThrow("invalid_request")
  })
})
