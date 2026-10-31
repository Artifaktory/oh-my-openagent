import { canonicalJson, freezeSnapshot, sha256 } from "./protocol"
import { AutopilotError, type InstructionSnapshot, type PolicySnapshot } from "./types"

export function composeInstructionSnapshot(
  policy: PolicySnapshot,
  fixed: { readonly pluginRevision: string; readonly factory: string; readonly protocol: string },
): InstructionSnapshot {
  if (!fixed.pluginRevision || !fixed.factory || !fixed.protocol) throw new AutopilotError("invalid_configuration")
  const textFor = (channel: string) => policy.sources.filter(source => source.descriptor.channel === channel).map(source => source.text)
  // Native category append precedes direct replacement/append; skills prepend that editable portion.
  let editable = textFor("category_append").join("\n")
  const prompt = textFor("prompt")
  if (prompt.length) editable = prompt[0]
  const append = textFor("prompt_append")
  if (append.length) editable += (editable ? "\n" : "") + append[0]
  const skills = policy.sources.filter(source => ["skill", "caller_skill"].includes(source.descriptor.channel)).map(source => source.text)
  editable = [...skills, ...(editable ? [editable] : [])].join("\n\n")
  const text = [fixed.factory, fixed.protocol, editable, ...textFor("rule")].filter(Boolean).join("\n\n")
  const compositionVersion = "1"
  const digest = sha256(canonicalJson({ compositionVersion, pluginRevision: fixed.pluginRevision, policyDigest: policy.policyDigest,
    factory: fixed.factory, protocol: fixed.protocol, sources: policy.sources.map(source => ({ ...source.descriptor, text: source.text })), text }))
  return freezeSnapshot({ text, digest, compositionVersion, manifestDigest: policy.manifestDigest,
    policyDigest: policy.policyDigest, configurationDigest: policy.configurationDigest })
}
