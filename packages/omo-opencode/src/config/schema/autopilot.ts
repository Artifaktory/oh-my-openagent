import { z } from "zod"
import { PolicySourceIdentitySchema, POLICY_LIMITS } from "../../features/autopilot/policy-schema"

const boundedPath = z.string().min(1).max(2048)
const roots = z.array(boundedPath).min(1).max(32)

const AutopilotEnrollmentSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  workspace: boundedPath,
  task_store_roots: roots,
  policy_roots: roots,
  evidence_roots: roots,
  manifest: boundedPath,
  sources: z.array(PolicySourceIdentitySchema).max(POLICY_LIMITS.sourceCount),
})

export const AutopilotConfigSchema = z.strictObject({
  format_version: z.literal("1"),
  mode: z.enum(["off", "on"]).optional(),
  enrollments: z.array(AutopilotEnrollmentSchema).max(32).optional(),
  enrollment_ids: z.array(z.string().min(1).max(128)).max(32).optional(),
  limits: z.strictObject({
    timeout_ms: z.number().int().min(1).max(120000).optional(),
    max_fallbacks: z.number().int().min(0).max(1).optional(),
    max_file_bytes: z.number().int().min(1).max(POLICY_LIMITS.fileBytes).optional(),
    max_total_bytes: z.number().int().min(1).max(POLICY_LIMITS.totalBytes).optional(),
    max_sources: z.number().int().min(1).max(POLICY_LIMITS.sourceCount).optional(),
  }).optional(),
}).superRefine((value, ctx) => {
  const ids = value.enrollments?.map(entry => entry.id) ?? []
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "duplicate_enrollment" })
  for (const entry of value.enrollments ?? []) {
    if (new Set(entry.sources.map(source => source.id)).size !== entry.sources.length) {
      ctx.addIssue({ code: "custom", message: "duplicate_source" })
    }
  }
})

export type AutopilotConfig = z.infer<typeof AutopilotConfigSchema>
export type AutopilotEnrollment = z.infer<typeof AutopilotEnrollmentSchema>
