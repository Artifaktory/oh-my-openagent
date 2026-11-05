import { readPolicyFile, type PolicyFileScope } from "./policy-file-reader"
import { NativeInstructionViewSchema, POLICY_LIMITS, PolicyManifestSchema } from "./policy-schema"
import { canonicalJson, freezeSnapshot, sha256 } from "./protocol"
import { AutopilotError, type CapturedPolicySource, type PolicySnapshot, type PolicySource } from "./types"

export type EnrolledSource = Omit<PolicySource, "sha256">
export interface NativeInstructionView {
  readonly configurationDigest: string
  readonly sources: readonly (EnrolledSource & { readonly text?: string })[]
}
export interface PolicySnapshotInput extends PolicyFileScope {
  readonly manifestPath: string
  readonly enrollment: readonly EnrolledSource[]
  readonly readNativeView: () => Promise<NativeInstructionView>
  readonly maxTotalBytes?: number
  readonly maxSources?: number
}

function sourceKey(source: EnrolledSource): string {
  return canonicalJson({ id: source.id, channel: source.channel, kind: source.kind, source: source.source })
}

export async function capturePolicySnapshot(input: PolicySnapshotInput): Promise<PolicySnapshot> {
  // Copy operator-owned inputs before the first asynchronous boundary.
  if (!input.roots.length || input.roots.length > 32 || input.enrollment.length > POLICY_LIMITS.sourceCount) {
    throw new AutopilotError("invalid_configuration")
  }
  const scope = freezeSnapshot({ directory: input.directory, roots: [...input.roots],
    ...(input.maxFileBytes === undefined ? {} : { maxFileBytes: input.maxFileBytes }) })
  const manifestPath = input.manifestPath
  const enrolled = new Set(input.enrollment.map(sourceKey))
  const readView = input.readNativeView
  const readNativeView = async () => {
    try {
      const parsed = NativeInstructionViewSchema.safeParse(await readView())
      if (!parsed.success) throw new AutopilotError("invalid_configuration")
      return freezeSnapshot(parsed.data)
    } catch { throw new AutopilotError("invalid_configuration") }
  }
  const maxTotal = input.maxTotalBytes ?? POLICY_LIMITS.totalBytes
  const maxSources = input.maxSources ?? POLICY_LIMITS.sourceCount
  if (!Number.isSafeInteger(maxTotal) || maxTotal < 1 || maxTotal > POLICY_LIMITS.totalBytes
    || !Number.isSafeInteger(maxSources) || maxSources < 1 || maxSources > POLICY_LIMITS.sourceCount) {
    throw new AutopilotError("invalid_configuration")
  }
  const native = await readNativeView()
  if (native.sources.length > maxSources) {
    throw new AutopilotError("invalid_configuration")
  }
  for (const source of native.sources) {
    if (source.channel === "rule" || !enrolled.has(sourceKey(source))) throw new AutopilotError("source_unenrolled")
  }
  const first = await readPolicyFile(manifestPath, scope)
  let raw: unknown
  try { raw = JSON.parse(first.text) } catch { throw new AutopilotError("invalid_manifest") }
  const parsed = PolicyManifestSchema.safeParse(raw)
  if (!parsed.success || parsed.data.sources.length > maxSources) throw new AutopilotError("invalid_manifest")
  const manifest = parsed.data
  for (const source of manifest.sources) {
    if (!enrolled.has(sourceKey(source))) throw new AutopilotError("source_unenrolled")
  }
  if (canonicalJson(manifest.sources.filter(source => source.channel !== "rule").map(sourceKey))
    !== canonicalJson(native.sources.map(sourceKey))) throw new AutopilotError("source_unenrolled")
  let total = first.byteLength
  const sources: CapturedPolicySource[] = []
  for (const descriptor of manifest.sources) {
    const file = descriptor.kind === "file" ? await readPolicyFile(descriptor.source, scope) : undefined
    const text = file?.text ?? native.sources.find(source => sourceKey(source) === sourceKey(descriptor))?.text
    if (text === undefined) throw new AutopilotError("source_unavailable")
    const length = Buffer.byteLength(text)
    total += length
    if (length > (scope.maxFileBytes ?? POLICY_LIMITS.fileBytes) || total > maxTotal) throw new AutopilotError("source_too_large")
    if (sha256(text) !== descriptor.sha256) throw new AutopilotError("policy_mismatch")
    sources.push({ descriptor, ...(file ? { file } : {}), text })
  }
  if (canonicalJson(await readNativeView()) !== canonicalJson(native)) throw new AutopilotError("source_changed")
  // Confirm every captured file, then the publication. No cached bytes enter this transaction.
  for (const source of sources) {
    if (!source.file) continue
    const current = await readPolicyFile(source.descriptor.source, scope)
    if (current.identity !== source.file.identity || current.sha256 !== source.file.sha256) throw new AutopilotError("source_changed")
  }
  const last = await readPolicyFile(manifestPath, scope)
  if (first.path !== last.path || first.identity !== last.identity || first.sha256 !== last.sha256) throw new AutopilotError("source_changed")
  return freezeSnapshot({ manifest, manifestDigest: first.sha256, configurationDigest: native.configurationDigest,
    policyDigest: sha256(canonicalJson(sources.map(({ descriptor, file }) => ({ ...descriptor, path: file?.path ?? descriptor.source })))),
    sources })
}
