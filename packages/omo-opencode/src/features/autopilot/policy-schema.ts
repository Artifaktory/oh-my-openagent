import { z } from "zod"
import { DigestSchema, IdentifierSchema } from "./protocol"

export const PolicySourceIdentitySchema = z.strictObject({
  id: IdentifierSchema,
  channel: z.enum(["category_append", "prompt", "prompt_append", "skill", "caller_skill", "rule"]),
  kind: z.enum(["file", "inline"]),
  source: z.string().min(1).max(2048),
})

export const PolicySourceSchema = PolicySourceIdentitySchema.extend({ sha256: DigestSchema })
  .refine(source => source.channel !== "rule" || source.kind === "file")

export const NativeInstructionViewSchema = z.strictObject({
  configurationDigest: DigestSchema,
  sources: z.array(PolicySourceIdentitySchema.extend({ text: z.string().max(65536).optional() })
    .refine(source => source.channel !== "rule" && (source.kind === "inline" ? source.text !== undefined : source.text === undefined))).max(32),
})

export const PolicyManifestSchema = z.strictObject({
  format_version: z.literal("1"),
  revision: IdentifierSchema,
  sources: z.array(PolicySourceSchema).min(1).max(32),
}).superRefine((manifest, ctx) => {
  const ids = new Set<string>()
  const identities = new Set<string>()
  const singletonChannels = new Set<string>()
  for (const source of manifest.sources) {
    const identity = JSON.stringify([source.channel, source.kind, source.source])
    if (ids.has(source.id) || identities.has(identity)
      || (["prompt", "prompt_append", "category_append"].includes(source.channel) && singletonChannels.has(source.channel))) {
      ctx.addIssue({ code: "custom", message: "conflicting_source" })
    }
    ids.add(source.id)
    identities.add(identity)
    singletonChannels.add(source.channel)
  }
  if (!manifest.sources.some(source => source.channel === "rule")) ctx.addIssue({ code: "custom", message: "missing_rules" })
})

export const POLICY_LIMITS = Object.freeze({ fileBytes: 65536, totalBytes: 262144, sourceCount: 32 })
