import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

export type Data = Record<string, unknown>
export const object = (value: unknown): Data => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Data : {}
export const digest = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex")
export function check(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code)
}
export async function bounded<T>(promise: Promise<T>, ms: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(code)), ms) })]) }
  finally { if (timer) clearTimeout(timer) }
}
export function ordinaryText(value: unknown): Data {
  if (typeof value !== "string") return { present: value !== undefined, type: typeof value, text: null }
  const sanitized = value
    .replace(/```[\s\S]*?```/g, "[redacted block]")
    .replace(/<(?:system|instructions|policy|request)\b[^>]*>[\s\S]*?<\/(?:system|instructions|policy|request)>/gi, "[redacted block]")
    .replace(/\{[\s\S]*\}/g, "[redacted structured data]")
    .replace(/^.*\b(?:authorization|cookie|api[_-]?key|access[_-]?token|password|secret|system[_ -]?prompt|instructions|policy|request[_ -]?body)\s*[:=].*$/gim, "[redacted sensitive line]")
    .replace(/\bBearer\s+\S+|\b(?:sk-|gh[pousr]_|github_pat_)[A-Za-z0-9_-]{16,}/gi, "[redacted credential]")
    .replace(/https?:\/\/[^\s<>"']+/gi, "[redacted URL]")
    .replace(/[?&][a-z0-9_.-]+=[^\s&<>"']*/gi, "[redacted query field]")
    .replace(/(?:[A-Z]:[\\/]|\\\\)[^\r\n<>"']+|\/(?:home|Users|tmp|var|private)\/[^\s<>"']+/gi, "[redacted path]")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .split(/\r?\n/).map(line => /^(?:\s*$|\[redacted|ORDINARY_AGENT_OK\b|Error\b|Failed\b|Unable\b|Cannot\b|Could not\b|Invalid\b|Denied\b|Task\b|Agent:|Session\b|session_id:|task_id:|<\/?task_metadata>|to continue:|\s+at\s|[a-z]+(?:_[a-z0-9]+)+$)/i.test(line)
      ? line : "[redacted non-diagnostic line]").join("\n")
  const text = sanitized.slice(0, 4096)
  return { present: true, text, source_bytes: Buffer.byteLength(value), sanitized_sha256: digest(text),
    sanitized_bytes: Buffer.byteLength(text), truncated: sanitized.length > text.length, redacted: sanitized !== value }
}
export function ordinaryInput(value: unknown, agent: string): Data {
  const input = object(value)
  return { present: value !== undefined,
    prompt: input.prompt === "Return ORDINARY_AGENT_OK." ? input.prompt : "[absent or unexpected prompt redacted]",
    description: input.description === "Bounded QA assessment" ? input.description : "[absent or unexpected description redacted]",
    subagent_type: input.subagent_type === agent ? input.subagent_type : "[absent or unexpected agent redacted]",
    task_id_present: Object.hasOwn(input, "task_id"),
    task_id: input.task_id === undefined || input.task_id === null ? null : input.task_id === "" ? "" : typeof input.task_id === "string" && /^ses_[a-z0-9_-]{1,128}$/i.test(input.task_id)
      ? input.task_id : "[unexpected task_id redacted]",
    run_in_background: typeof input.run_in_background === "boolean" ? input.run_in_background : null,
    load_skills: Array.isArray(input.load_skills) && input.load_skills.length === 0 ? [] : "[absent or unexpected skills redacted]" }
}
export function ordinaryMessages(value: unknown): Data {
  if (!Array.isArray(value)) return { available: false }
  const messages = value.map(message => {
    const info = object(object(message).info), model = object(info.model)
    return { id: info.id, session_id: info.sessionID, parent_id: info.parentID ?? null, role: info.role, agent: info.agent,
      provider_id: info.providerID ?? model.providerID ?? null, model_id: info.modelID ?? model.modelID ?? null,
      finish: info.finish ?? null, tools_star_false: object(info.tools)["*"] === false }
  })
  return { available: true, user_count: messages.filter(info => info.role === "user").length, messages: messages.slice(-32),
    message_count: messages.length, truncated: messages.length > 32 }
}
interface CaseResult { id: string; acceptance: string[]; status: "passed" | "failed" | "pending"; surface: string; observations?: Data; error?: string }
const CASES: [string, string[], string][] = [
  ["native-task", ["AC01", "AC02", "AC04", "AC07", "AC10"], "real-host/fixture-transport"],
  ["model-policy-ab-revert", ["AC06", "AC07", "AC08", "AC11"], "real-host/actual-model"],
  ["policy-file-negatives", ["AC03", "AC08", "AC11"], "real-host/fixture-transport"],
  ["native-config", ["AC09", "AC10"], "real-host/fixture-transport"],
  ["native-fallback", ["AC03", "AC09", "AC10"], "real-host/fixture-transport"],
  ["authority-off", ["AC03", "AC04", "AC10"], "real-host/fixture-transport"],
  ["ordinary-agent", ["AC04"], "real-host/fixture-transport"],
  ["lifecycle-rejections", ["AC03", "AC06", "AC10", "AC11"], "real-host/fixture-transport"],
  ["malformed-result", ["AC03"], "real-host/fixture-transport"],
  ["tool-boundary", ["AC03", "AC10"], "real-host/fixture-transport"],
  ["cancellation", ["AC03", "AC10", "AC11"], "real-host/fixture-transport"],
  ["short-budget-recovery", ["AC03", "AC10", "AC11"], "real-host/fixture-transport; provider-response deadline"],
  ["child-deletion-recovery", ["AC10", "AC11"], "real-host/fixture-transport; native deletion event"],
  ["custom-name-restart", ["AC04", "AC06", "AC10", "AC11"], "real-host/fixture-transport; persisted native context and ordinary continuation"],
]
export class Evidence {
  readonly cases: CaseResult[] = CASES.map(([id, acceptance, surface]) => ({ id, acceptance, surface, status: "pending" }))
  readonly started = Date.now()
  readonly metadata: Data = {}
  constructor(readonly directory: string, readonly mode: string) {}
  async run(id: string, action: () => Promise<Data>): Promise<void> {
    const entry = this.cases.find(item => item.id === id)
    check(entry && entry.status === "pending", "case_identity_invalid")
    try { entry.observations = await action(); entry.status = "passed" }
    catch (error) {
      entry.status = "failed"
      entry.error = error instanceof Error && /^[a-z0-9_:.-]{1,160}$/i.test(error.message) ? error.message : "operation_failed_redacted"
      throw error
    } finally { await this.save() }
  }
  async save(): Promise<Data> {
    const acceptance = Array.from({ length: 11 }, (_, i) => {
      const id = `AC${String(i + 1).padStart(2, "0")}`
      const cases = this.cases.filter(item => item.acceptance.includes(id))
      return { id, status: "pending", driver_cases: cases.map(item => ({ id: item.id, status: item.status })),
        reason: id === "AC05" ? "Full checks, documentation, independent review and triage are coordinator gates" : "Driver observations require assembled qualification and independent acceptance" }
    })
    const result = { schema_version: "1", mode: this.mode, started_at: new Date(this.started).toISOString(),
      duration_ms: Date.now() - this.started, status: this.metadata.failed === true || this.cases.some(item => item.status === "failed") ? "failed"
        : this.cases.some(item => item.status === "pending") || this.mode !== "real" ? "incomplete" : "driver_checks_passed_acceptance_pending",
      cases: this.cases, acceptance, ...this.metadata,
      omissions: ["Raw policy, evidence, configuration, auth, requests and model transcripts are never captured", "Public provenance is not a private receipt", "No claim about closed provider internals"],
      required_gates: ["Required repository checks and generated schema freshness", "Independent Quality/general/security repair Delta and triage; prior Full retained", "Coordinator acceptance of AC01 through AC11"] }
    await mkdir(this.directory, { recursive: true })
    await writeFile(path.join(this.directory, "result.json"), JSON.stringify(result, null, 2) + "\n")
    return result
  }
}
export async function verifyManifest(file: string, root: string): Promise<string> {
  const bytes = await readFile(file)
  const manifest = object(JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, "")))
  check(Array.isArray(manifest.files) && manifest.files.length > 0, "source_manifest_empty")
  for (const value of manifest.files) {
    const item = object(value), relative = String(item.path), target = path.resolve(root, relative)
    check(!path.relative(root, target).startsWith("..") && !path.isAbsolute(relative), "source_manifest_path_invalid")
    check(digest(await readFile(target)) === item.sha256, "source_manifest_changed")
  }
  return digest(bytes)
}
