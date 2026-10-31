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
      required_gates: ["Required repository checks and generated schema freshness", "Independent Quality/general/security Full and triage", "Coordinator acceptance of AC01 through AC11"] }
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
