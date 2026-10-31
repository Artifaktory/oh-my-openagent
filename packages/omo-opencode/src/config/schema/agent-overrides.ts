import { OmoReasoningSchema } from "@oh-my-opencode/omo-config-core"
import { z } from "zod"
import { FallbackModelObjectSchema, FallbackModelsSchema } from "./fallback-models"
import { AgentPermissionSchema } from "./internal/permission"

export const AgentOverrideConfigSchema = z.object({
  /** @deprecated Use `category` instead. Model is inherited from category defaults. */
  model: z.string().optional(),
  /** Ordered model chain; the first entry is primary and the rest are fallbacks. */
  models: z.array(z.union([z.string(), FallbackModelObjectSchema])).optional(),
  fallback_models: FallbackModelsSchema.optional(),
  reasoning: OmoReasoningSchema.optional(),
  /** @deprecated Use `reasoning` instead. */
  variant: z.string().optional(),
  /** Category name to inherit model and other settings from CategoryConfig */
  category: z.string().optional(),
  /** Skill names to inject into agent prompt */
  skills: z.array(z.string()).optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  prompt: z.string().optional(),
  /** Text to append to agent prompt. Supports file:// URIs (file:///abs, file://./rel, file://~/home) */
  prompt_append: z.string().optional(),
  tools: z.record(z.string(), z.boolean()).optional(),
  disable: z.boolean().optional(),
  description: z.string().optional(),
  mode: z.enum(["subagent", "primary", "all"]).optional(),
  color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/)
    .optional(),
  /** Localized display name shown in TUI agent selector (i18n support). Falls back to hardcoded English when not set. */
  displayName: z.string().optional(),
  permission: AgentPermissionSchema.optional(),
  /** Maximum tokens for response. Passed directly to OpenCode SDK. */
  maxTokens: z.number().optional(),
  /** Extended thinking configuration (Anthropic). Overrides category and default settings. */
  thinking: z
    .object({
      type: z.enum(["enabled", "disabled"]),
      budgetTokens: z.number().optional(),
    })
    .optional(),
  /** @deprecated Use `reasoning` instead. */
  reasoningEffort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
  /** Text verbosity level. */
  textVerbosity: z.enum(["low", "medium", "high"]).optional(),
  /** Provider-specific options. Passed directly to OpenCode SDK. */
  providerOptions: z.record(z.string(), z.unknown()).optional(),
  /** Per-message ultrawork override model/reasoning when ultrawork keyword is detected. */
  ultrawork: z
    .object({
      model: z.string().optional(),
      reasoning: OmoReasoningSchema.optional(),
      /** @deprecated Use `reasoning` instead. */
      variant: z.string().optional(),
    })
    .optional(),
  compaction: z
    .object({
      model: z.string().optional(),
      reasoning: OmoReasoningSchema.optional(),
      /** @deprecated Use `reasoning` instead. */
      variant: z.string().optional(),
    })
    .optional(),
})

export const AutopilotAgentOverrideSchema = AgentOverrideConfigSchema.strict().superRefine((value, ctx) => {
  const reject = (path: string) => ctx.addIssue({ code: "custom", path: [path], message: "invalid_autopilot_setting" })
  if (value.mode !== undefined && value.mode !== "subagent") reject("mode")
  for (const field of ["providerOptions", "ultrawork", "compaction"] as const) {
    if (value[field] !== undefined) reject(field)
  }
  const entries = [...(value.models ?? []), ...(typeof value.fallback_models === "string"
    ? [value.fallback_models] : value.fallback_models ?? [])]
  if (value.model !== undefined && !value.model.trim()) reject("model")
  if ((value.model?.length ?? 0) > 256) reject("model")
  if (value.models?.length === 0) reject("models")
  if ((value.skills?.length ?? 0) > 32 || value.skills?.some(skill => !skill || skill.length > 256)) reject("skills")
  if ((value.prompt?.length ?? 0) > 65536 || (value.prompt_append?.length ?? 0) > 65536) reject("prompt")
  if (entries.length > 32 || entries.some(entry => (typeof entry === "string" ? entry : entry.model).length > 256)) reject("models")
  if (entries.some(entry => !(typeof entry === "string" ? entry : entry.model).trim())) reject("models")
  for (const settings of [value, ...entries.filter(entry => typeof entry !== "string")]) {
    if (settings.maxTokens !== undefined && (!Number.isSafeInteger(settings.maxTokens) || settings.maxTokens < 1)) reject("maxTokens")
    const budget = settings.thinking?.budgetTokens
    if (budget !== undefined && (!Number.isSafeInteger(budget) || budget < 1)) reject("thinking")
  }
  for (const [tool, enabled] of Object.entries(value.tools ?? {})) {
    if (enabled && !["read", "glob", "grep"].includes(tool)) reject("tools")
  }
  for (const [tool, permission] of Object.entries(value.permission ?? {})) {
    if (permission !== "deny" && !(["read", "glob", "grep"].includes(tool) && ["allow", "ask"].includes(String(permission)))) reject("permission")
  }
})

export const AgentOverridesSchema = z.object({
  autopilot: AutopilotAgentOverrideSchema.optional(),
  build: AgentOverrideConfigSchema.optional(),
  plan: AgentOverrideConfigSchema.optional(),
  sisyphus: AgentOverrideConfigSchema.optional(),
  hephaestus: AgentOverrideConfigSchema.extend({
    allow_non_gpt_model: z.boolean().optional(),
  }).optional(),
  "sisyphus-junior": AgentOverrideConfigSchema.optional(),
  "OpenCode-Builder": AgentOverrideConfigSchema.optional(),
  prometheus: AgentOverrideConfigSchema.optional(),
  metis: AgentOverrideConfigSchema.optional(),
  momus: AgentOverrideConfigSchema.optional(),
  oracle: AgentOverrideConfigSchema.optional(),
  librarian: AgentOverrideConfigSchema.optional(),
  explore: AgentOverrideConfigSchema.optional(),
  "multimodal-looker": AgentOverrideConfigSchema.optional(),
  atlas: AgentOverrideConfigSchema.optional(),
}).catchall(AgentOverrideConfigSchema.optional())

export type AgentOverrideConfig = z.infer<typeof AgentOverrideConfigSchema>
export type AgentOverrides = z.infer<typeof AgentOverridesSchema>
