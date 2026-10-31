import { mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises"
import { spawn } from "node:child_process"
import path from "node:path"
import { bounded, check, digest, object } from "./autopilot-evidence"
import type { Data } from "./autopilot-evidence"
import type { Context } from "./autopilot-host"
import { RULE_A, RULE_B } from "./autopilot-fixtures"

export function rejected(result: Data, errors: readonly string[]): Data {
  check(result.outcome === "human_required" && errors.includes(String(result.error)) && result.decision === undefined
    && result.provenance === undefined, "expected_bounded_rejection_missing")
  return { outcome: result.outcome, error: result.error, parent_message_id: result.qa_parent_message_id, call_id: result.qa_call_id }
}
async function unreadablePolicyCase({ fixture, host, provider }: Context): Promise<Data> {
  check(process.platform === "win32", "unreadable_source_control_requires_windows")
  const source = fixture.rules[0], beforeHash = digest(await readFile(source))
  const ready = Promise.withResolvers<void>(), closed = Promise.withResolvers<number | null>()
  const script = "$ErrorActionPreference = 'Stop'; $file = [System.IO.File]::Open($env:OMO_QA_LOCK_PATH, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None); try { [Console]::Out.WriteLine('locked'); [Console]::Out.Flush(); [Console]::In.ReadLine() | Out-Null } finally { $file.Dispose() }"
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    cwd: fixture.workspace, env: { ...fixture.env, OMO_QA_LOCK_PATH: source }, stdio: ["pipe", "pipe", "ignore"], windowsHide: true,
  })
  child.once("error", () => ready.reject(new Error("policy_lock_spawn_failed")))
  child.once("close", code => { closed.resolve(code); ready.reject(new Error("policy_lock_closed_before_ready")) })
  let output = ""
  child.stdout.on("data", (chunk: Buffer) => { output = (output + chunk.toString("utf8")).slice(-64); if (output.includes("locked")) ready.resolve() })
  try {
    await bounded(ready.promise, 10000, "policy_lock_not_ready")
    let readError: unknown
    try { await readFile(source) } catch (error) { readError = error }
    const code = object(readError).code
    check(["EBUSY", "EACCES", "EPERM"].includes(String(code)), "policy_lock_did_not_deny_read")
    const before = provider.records.length, result = await host.invoke({ id: "unreadable-rule", arguments: fixture.arguments() })
    const rejection = rejected(result, ["source_unavailable"])
    check(!provider.records.slice(before).some(record => record.invocation_id), "unreadable_policy_dispatched_child")
    return { id: "unreadable-rule", ...rejection, native_read_error: code, mechanism: "exclusive Windows file sharing lock", acl_changed: false }
  } finally {
    child.stdin.end("\n")
    try { check(await bounded(closed.promise, 10000, "policy_lock_release_timeout") === 0, "policy_lock_exit_failed") }
    catch (error) { child.kill(); await bounded(closed.promise, 5000, "policy_lock_cleanup_timeout"); throw error }
    check(digest(await readFile(source)) === beforeHash, "policy_lock_changed_source")
  }
}
export async function modelPolicyCases(context: Context, backendModel: string, backendEffort: string): Promise<Data> {
  const { fixture, host, provider } = context
  await fixture.reset()
  await fixture.publish(RULE_A, "model-A")
  const constant = await fixture.contentIdentity(), previousStats = await provider.backendStats()
  const lastID = Math.max(0, ...previousStats.map(record => Number(record.id) || 0))
  const latch = provider.latch("inflight-A")
  const first = host.invoke({ id: "model-A", arguments: fixture.arguments(), backend: "real", hold: "inflight-A" })
  try {
    await Promise.race([latch.entered, first.then(() => { throw new Error("child_latch_not_exercised") })])
    await fixture.publish(RULE_B, "model-B")
  } finally { latch.release() }
  const a = await first, aEvidence = await host.verify(a)
  check(object(a.decision).outcome === "approve" && object(a.policy).revision === "model-A", "inflight_A_snapshot_or_judgment_failed")
  const b = await host.invoke({ id: "model-B", arguments: fixture.arguments(), backend: "real" }), bEvidence = await host.verify(b)
  check(object(b.decision).outcome === "rework" && object(b.policy).revision === "model-B", "published_B_judgment_failed")
  await fixture.publish(RULE_A, "revert-A-new-publication")
  const reverted = await host.invoke({ id: "model-revert", arguments: fixture.arguments(), backend: "real" }), revertEvidence = await host.verify(reverted)
  check(object(reverted.decision).outcome === "approve", "revert_A_judgment_failed")
  const policies = [a, b, reverted].map(result => object(result.policy))
  check(policies[0].policy_digest !== policies[1].policy_digest && policies[0].policy_digest === policies[2].policy_digest
    && policies[0].manifest_digest !== policies[2].manifest_digest, "policy_publication_identity_failed")
  check(new Set([a, b, reverted].map(result => object(result.provenance).child_session_id)).size === 3, "fresh_child_required")
  check(JSON.stringify(constant) === JSON.stringify(await fixture.contentIdentity()), "assessment_subject_or_evidence_changed")
  const backendRecords = (await provider.backendStats()).filter(record => Number(record.id) > lastID)
  const native = backendRecords.filter(record => record.kind === "native_model")
  check(native.length === 3 && native.every(record => record.model === backendModel && record.effort === backendEffort && record.exit_code === 0
    && Array.isArray(record.tool_event_types) && record.tool_event_types.length === 0), "actual_model_identity_or_completion_failed")
  const transport = provider.records.filter(record => ["model-A", "model-B", "model-revert"].includes(String(record.case_id)) && record.invocation_id)
  check(transport.length === 3 && new Set(transport.map(record => record.backend_response_id)).size === 3, "actual_backend_output_correlation_failed")
  const bindings = [aEvidence, bEvidence, revertEvidence].map(observed => {
    const requests = transport.filter(record => record.invocation_id === observed.invocation_id && record.request_digest === observed.request_digest)
    check(requests.length === 1, "actual_backend_request_correlation_failed")
    const request = requests[0], model = native.find(record => record.id === request.backend_response_id)
    const ingress = backendRecords.filter(record => record.kind === "transport" && record.id === request.backend_response_id)
    check(model && ingress.length === 1 && ingress[0].request_sha256 === request.request_sha256
      && ingress[0].case_id === request.case_id && ingress[0].model === request.model
      && model.final_sha256 === request.final_sha256 && observed.final_text_sha256 === request.final_sha256, "actual_backend_request_or_output_mismatch")
    return { invocation_id: observed.invocation_id, request_digest: observed.request_digest, backend_id: model.id,
      request_sha256: request.request_sha256, final_sha256: request.final_sha256 }
  })
  return { a: aEvidence, b: bEvidence, revert: revertEvidence, constant, explicit_latch_observed: true, same_server_and_parent: true,
    backend_bindings: bindings,
    native_backend: native.map(record => Object.fromEntries(["id", "thread_id", "model", "effort", "exit_code", "prompt_sha256", "final_sha256", "context_limit"].map(key => [key, record[key]]))),
    limitation: "Native backend adds its own context. OpenCode transport model identity and backend model identity are recorded separately; no closed-provider internals claim." }
}
export async function policyNegativeCases({ fixture, host, provider }: Context): Promise<Data> {
  const observations: Data[] = []
  const tests: { id: string; error: string; mutate: () => Promise<unknown> }[] = [
    { id: "missing-manifest", error: "source_unavailable", mutate: () => rm(fixture.manifest) },
    { id: "invalid-manifest", error: "invalid_manifest", mutate: () => writeFile(fixture.manifest, "{") },
    { id: "unpublished-edit", error: "policy_mismatch", mutate: () => writeFile(fixture.rules[0], RULE_B) },
    { id: "removed-rule", error: "source_unavailable", mutate: () => rm(fixture.rules[1]) },
    { id: "invalid-utf8", error: "invalid_utf8", mutate: () => writeFile(fixture.rules[0], Buffer.from([0xff])) },
    { id: "non-file-source", error: "source_forbidden", mutate: async () => { await rm(fixture.rules[0]); await mkdir(fixture.rules[0]) } },
    { id: "unenrolled-source", error: "source_unenrolled", mutate: async () => {
      const value = object(JSON.parse(await readFile(fixture.manifest, "utf8"))), sources = value.sources as Data[]
      sources.push({ id: "extra", channel: "rule", kind: "file", source: path.join(fixture.workspace, "policy", "other.md"), sha256: digest("other") })
      await writeFile(fixture.manifest, JSON.stringify(value))
    } },
    { id: "conflicting-source", error: "invalid_manifest", mutate: async () => {
      const value = object(JSON.parse(await readFile(fixture.manifest, "utf8"))), sources = value.sources as Data[]
      sources.push(sources[0]); await writeFile(fixture.manifest, JSON.stringify(value))
    } },
    { id: "mixed-files", error: "policy_mismatch", mutate: async () => {
      await fixture.publish(RULE_B, "mixed-B"); await writeFile(fixture.rules[1], "Unpublished second rule")
    } },
    { id: "missing-evidence", error: "source_unavailable", mutate: () => rm(path.join(fixture.workspace, "evidence", "check.json")) },
  ]
  const evidencePath = path.join(fixture.workspace, "evidence", "check.json"), evidenceBytes = await readFile(evidencePath)
  for (const test of tests) {
    await test.mutate()
    const before = provider.records.length
    try {
      const result = await host.invoke({ id: test.id, arguments: fixture.arguments() })
      observations.push({ id: test.id, ...rejected(result, [test.error]) })
      check(!provider.records.slice(before).some(record => record.invocation_id), "invalid_policy_dispatched_child")
    } finally {
      if (test.id === "non-file-source") await rmdir(fixture.rules[0])
      await writeFile(evidencePath, evidenceBytes); await fixture.publish(RULE_A, `restored-${test.id}`)
    }
  }
  observations.push(await unreadablePolicyCase({ fixture, host, provider }))
  return { observations, unreadable_source_control: "exclusive file sharing denial; no ACL changes" }
}
