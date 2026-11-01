import path from "node:path"
import { fileURLToPath } from "node:url"
import type { AgentConfig } from "@opencode-ai/sdk"
import type { OmoConfigEnv } from "@oh-my-opencode/omo-config-core"
import { normalizeReasoning } from "@oh-my-opencode/model-core"
import type { FallbackModelObject } from "../../config/schema/fallback-models"
import { validatePluginConfig } from "../../config/validate"
import { AutopilotAgentOverrideSchema, type AgentOverrideConfig } from "../../config/schema/agent-overrides"
import { CategoryConfigSchema, type CategoryConfig } from "../../config/schema/categories"
import { createAutopilotAgent } from "../../agents/autopilot"
import { applyOverrides } from "../../agents/builtin-agents/agent-overrides"
import { resolveAgentSkills } from "../../agents/agent-skill-resolution"
import { mergeCategories } from "../../shared/merge-categories"
import { resolveModelPipeline } from "../../shared/model-resolution-pipeline"
import { AGENT_MODEL_REQUIREMENTS } from "../../shared/model-requirements"
import { isProviderDisabled } from "../../shared/disabled-providers"
import { getModelCapabilities } from "../../shared/model-capabilities"
import { getAutopilotBinding, type AutopilotBinding } from "./authority"
import { canonicalJson, freezeSnapshot, sha256 } from "./protocol"
import type { EnrolledSource, NativeInstructionView } from "./policy-snapshot"
import { AutopilotError } from "./types"

export interface AutopilotNativeOptions {
  readonly availableModels: Set<string>
  readonly systemDefaultModel?: string
  readonly callerSkills?: readonly string[]
}

export interface AutopilotNativeProjection {
  readonly binding: AutopilotBinding
  readonly agent: AgentConfig
  readonly configurationDigest: string
  readonly sources: readonly (EnrolledSource & { readonly text?: string })[]
  readonly deferredSkills: readonly { readonly name: string; readonly source: EnrolledSource }[]
  readonly models: readonly FallbackModelObject[]
  readonly allowedTools: readonly string[]
  readonly workspace: string
}

function digest(value: unknown): string {
  return sha256(canonicalJson(JSON.parse(JSON.stringify(value))))
}

function reference(value: string, directory: string): string {
  if (!value.startsWith("file://")) return value
  const suffix = value.slice(7)
  if (/(^|[\\/])\.\.([\\/]|$)/.test(suffix) || suffix.startsWith("~")) throw new AutopilotError("source_forbidden")
  if (suffix.startsWith("./")) return path.resolve(directory, suffix)
  try { return fileURLToPath(value) } catch { throw new AutopilotError("source_forbidden") }
}

function checkSourcePath(value: string): void {
  const normalized = value.replace(/\\/g, "/")
  if (normalized.includes("\0") || normalized.startsWith("//") || /(^|\/)\.\.(\/|$)/.test(normalized)
    || /(^|\/)(\.env[^/]*|\.ssh|\.aws|\.azure|\.gnupg|\.codex|\.config|\.npmrc|secrets?[^/]*|credentials?[^/]*|auth\.json|id_rsa|id_ed25519)(\/|$)/i.test(normalized)
    || /\.(pem|key|p12|pfx)$/i.test(normalized)) throw new AutopilotError("source_forbidden")
}

function normalizedCategory(category: CategoryConfig | undefined): CategoryConfig | undefined {
  if (!category?.models) return category
  const [primary, ...fallbacks] = category.models
  if (!primary) throw new AutopilotError("invalid_configuration")
  const { models: _models, model: _model, reasoning: _reasoning, variant: _variant,
    reasoningEffort: _effort, ...rest } = category
  return { ...rest, ...(typeof primary === "string" ? { model: primary } : primary), fallback_models: fallbacks }
}

function modelEntries(value: AgentOverrideConfig["fallback_models"]): FallbackModelObject[] {
  return (typeof value === "string" ? [value] : value ?? []).map(entry => typeof entry === "string"
    ? { model: entry.trim() } : { ...entry, model: entry.model.trim() })
}

function instructions(binding: AutopilotBinding, override: AgentOverrideConfig, category: CategoryConfig | undefined, callerSkills: readonly string[]) {
  const enrollment = binding.enrollment
  if (!enrollment) throw new AutopilotError("invalid_configuration")
  const sources: (EnrolledSource & { text?: string })[] = []
  const deferredSkills: { name: string; source: EnrolledSource }[] = []
  const addText = (channel: EnrolledSource["channel"], field: string, value: string | undefined) => {
    if (value === undefined || value === "") return
    const kind = value.startsWith("file://") ? "file" : "inline"
    const source = kind === "file" ? reference(value, binding.workspace) : binding.origins[field]
    if (!source) throw new AutopilotError("source_unenrolled")
    if (kind === "file") checkSourcePath(source)
    const enrolled = enrollment.sources.find(item => item.channel === channel && item.kind === kind && item.source === source)
    if (!enrolled) throw new AutopilotError("source_unenrolled")
    sources.push({ ...enrolled, ...(kind === "inline" ? { text: value } : {}) })
  }
  addText("category_append", `categories.${override.category}.prompt_append`, category?.prompt_append)
  addText("prompt", "agents.autopilot.prompt", override.prompt)
  addText("prompt_append", "agents.autopilot.prompt_append", override.prompt_append)
  for (const [channel, names] of [["skill", override.skills ?? []], ["caller_skill", callerSkills]] as const) {
    for (const name of names) {
      if (binding.config.disabled_skills?.includes(name)) throw new AutopilotError("source_unavailable")
      // The operator binds the native skill name to its canonical source and expanded payload.
      const enrolled = enrollment.sources.find(item => item.channel === channel && item.id === name && item.kind === "inline")
      if (!enrolled || !path.isAbsolute(enrolled.source)
        || !enrollment.policy_roots.some(root => {
          const relative = path.relative(root, enrolled.source)
          return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
        })) throw new AutopilotError("source_unenrolled")
      checkSourcePath(enrolled.source)
      if (sources.some(item => item.id === enrolled.id)) throw new AutopilotError("invalid_configuration")
      sources.push({ ...enrolled })
      deferredSkills.push({ name, source: { ...enrolled } })
    }
  }
  if (sources.length > binding.limits.max_sources) throw new AutopilotError("invalid_configuration")
  return { sources, deferredSkills }
}

function ceiling(binding: AutopilotBinding, override: AgentOverrideConfig, category: CategoryConfig | undefined) {
  const requested = { ...category?.tools, ...override.tools }
  const permissions = override.permission ?? {}
  for (const [name, enabled] of Object.entries(requested)) {
    if (enabled && !["read", "glob", "grep"].includes(name)) throw new AutopilotError("invalid_configuration")
  }
  const tools: Record<string, boolean> = { "*": false }
  const permission: NonNullable<AgentConfig["permission"]> & Record<string, "allow" | "ask" | "deny" | Record<string, "allow" | "ask" | "deny">> = { "*": "deny", external_directory: "deny" }
  const allowedTools: string[] = []
  for (const name of ["read", "glob", "grep"]) {
    const value = permissions[name] ?? (requested[name] ? "allow" : "deny")
    if (value === "deny" || binding.config.disabled_tools?.includes(name)) { permission[name] = "deny"; continue }
    if (value !== "allow" && value !== "ask") throw new AutopilotError("invalid_configuration")
    allowedTools.push(name)
    tools[name] = true
    permission[name] = { "*": "deny", [`${binding.workspace.replace(/\\/g, "/")}/**`]: value,
      "**/.env*": "deny", "**/.ssh/**": "deny", "**/.aws/**": "deny", "**/.azure/**": "deny",
      "**/.gnupg/**": "deny", "**/.codex/**": "deny", "**/.config/**": "deny", "**/.npmrc": "deny",
      "**/*secret*": "deny", "**/*credential*": "deny", "**/auth.json": "deny", "**/*.pem": "deny",
      "**/*.key": "deny", "**/*.p12": "deny", "**/*.pfx": "deny", "**/id_rsa": "deny", "**/id_ed25519": "deny" }
  }
  return { tools, permission, allowedTools }
}

export function projectAutopilotNativeConfig(agents: object | undefined, options: AutopilotNativeOptions): AutopilotNativeProjection {
  const binding = getAutopilotBinding(agents)
  if (!binding || binding.state !== "enabled") throw new AutopilotError("invalid_configuration")
  const raw = structuredClone(binding.config.agents?.autopilot ?? {})
  const parsed = AutopilotAgentOverrideSchema.safeParse(raw)
  if (!parsed.success) throw new AutopilotError("invalid_configuration")
  const override = parsed.data
  const categories = mergeCategories(structuredClone(binding.config.categories) as Record<string, CategoryConfig> | undefined)
  const category = normalizedCategory(override.category ? categories[override.category] : undefined)
  if (override.category && !category) throw new AutopilotError("invalid_configuration")
  if (category && !CategoryConfigSchema.strict().safeParse(category).success) throw new AutopilotError("invalid_configuration")
  if (category?.provider_options !== undefined) throw new AutopilotError("invalid_configuration")
  const declaredFallbacks = override.fallback_models ?? category?.fallback_models
  let fallbacks = modelEntries(declaredFallbacks)
  const explicitModel = override.model ?? category?.model
  const resolution = resolveModelPipeline({ intent: { userModel: explicitModel,
    userFallbackModels: fallbacks.map(entry => entry.model) }, constraints: { availableModels: options.availableModels },
    policy: { fallbackChain: AGENT_MODEL_REQUIREMENTS.autopilot.fallbackChain, systemDefaultModel: options.systemDefaultModel } })
  if (!resolution || !resolution.model.includes("/") || (options.availableModels.size > 0 && !options.availableModels.has(resolution.model))) {
    throw new AutopilotError("invalid_configuration")
  }
  if (!explicitModel && declaredFallbacks === undefined && binding.limits.max_fallbacks > 0) {
    const remaining = new Set([...options.availableModels].filter(model => model !== resolution.model
      && !isProviderDisabled(model, binding.config.disabled_providers ?? [])))
    if (remaining.size > 0) {
      const next = resolveModelPipeline({ constraints: { availableModels: remaining }, policy: { fallbackChain: AGENT_MODEL_REQUIREMENTS.autopilot.fallbackChain } })
      if (next) fallbacks = [{ model: next.model, ...(next.variant ? { variant: next.variant } : {}) }]
    }
  }
  const applied = applyOverrides(createAutopilotAgent(resolution.model), override,
    override.category && category ? { [override.category]: category } : {}, binding.workspace, true)
  const agent = resolveAgentSkills(applied, { deferInstructions: true })
  agent.model = resolution.model
  agent.mode = "subagent"
  const restricted = ceiling(binding, override, category)
  agent.tools = restricted.tools
  agent.permission = restricted.permission
  const configuredReasoning = override.reasoning ?? override.variant ?? override.reasoningEffort
    ?? category?.reasoning ?? category?.variant ?? category?.reasoningEffort ?? resolution.variant
  if (configuredReasoning !== undefined) agent.variant = configuredReasoning
  const models: FallbackModelObject[] = [{ model: resolution.model, ...(override.reasoning ? { reasoning: override.reasoning }
    : category?.reasoning ? { reasoning: category.reasoning } : configuredReasoning ? { variant: configuredReasoning } : {}),
    ...(agent.temperature === undefined ? {} : { temperature: agent.temperature }),
    ...(override.top_p === undefined && category?.top_p === undefined ? {} : { top_p: override.top_p ?? category?.top_p }),
    ...(override.maxTokens === undefined && category?.maxTokens === undefined ? {} : { maxTokens: override.maxTokens ?? category?.maxTokens }),
    ...(override.thinking ?? category?.thinking ? { thinking: override.thinking ?? category?.thinking } : {}) },
    ...fallbacks.filter(entry => entry.model !== resolution.model).slice(0, binding.limits.max_fallbacks)]
  if (models.some(entry => !entry.model.includes("/") || isProviderDisabled(entry.model, binding.config.disabled_providers ?? [])
    || (options.availableModels.size > 0 && !options.availableModels.has(entry.model)))) throw new AutopilotError("invalid_configuration")
  for (const entry of models) {
    const reasoning = entry.reasoning ?? entry.variant
    const custom = reasoning === undefined ? undefined : normalizeReasoning(reasoning).passthrough
    if (!custom) continue
    const separator = entry.model.indexOf("/")
    const capabilities = getModelCapabilities({ providerID: entry.model.slice(0, separator), modelID: entry.model.slice(separator + 1) })
    if (!capabilities.variants?.includes(custom)) throw new AutopilotError("invalid_configuration")
  }
  const instruction = instructions(binding, override, category, options.callerSkills ?? [])
  agent.fallback_models = models.slice(1)
  const configurationDigest = digest({ sourceIdentity: binding.sourceIdentity, models, mode: agent.mode,
    temperature: agent.temperature, top_p: agent.top_p, maxTokens: agent.maxTokens, thinking: agent.thinking,
    textVerbosity: agent.textVerbosity, permission: agent.permission, tools: agent.tools,
    sources: instruction.sources, deferredSkills: instruction.deferredSkills })
  return freezeSnapshot({ binding, agent, configurationDigest, ...instruction, models,
    allowedTools: restricted.allowedTools, workspace: binding.workspace }) as AutopilotNativeProjection
}

export function refreshAutopilotNativeConfig(directory: string, options: AutopilotNativeOptions, environment: OmoConfigEnv = process.env): AutopilotNativeProjection {
  const validated = validatePluginConfig(directory, environment)
  return projectAutopilotNativeConfig(validated.config.agents, options)
}

/** The producer supplies only its enrolled, bounded native skill reader, never caller text. */
export async function readAutopilotInstructionView(
  projection: AutopilotNativeProjection,
  readSkill: (source: EnrolledSource, name: string) => Promise<string>,
): Promise<NativeInstructionView> {
  const sources = []
  for (const source of projection.sources) {
    const skill = projection.deferredSkills.find(item => item.source.id === source.id)
    let text = source.text
    if (skill) {
      try { text = await readSkill(skill.source, skill.name) }
      catch (error) { throw error instanceof AutopilotError ? error : new AutopilotError("source_unavailable") }
    }
    if (text !== undefined && Buffer.byteLength(text) > projection.binding.limits.max_file_bytes) throw new AutopilotError("source_too_large")
    sources.push({ ...source, ...(text === undefined ? {} : { text }) })
  }
  return freezeSnapshot({ configurationDigest: projection.configurationDigest, sources })
}
