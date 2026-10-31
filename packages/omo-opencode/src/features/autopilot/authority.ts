import { realpathSync } from "node:fs"
import path from "node:path"
import { AutopilotConfigSchema, type AutopilotEnrollment } from "../../config/schema/autopilot"
import { AutopilotAgentOverrideSchema } from "../../config/schema/agent-overrides"
import type { OhMyOpenCodeConfig } from "../../config/schema"
import { CategoryConfigSchema } from "../../config/schema/categories"
import type { OmoOpenCodeConfigChain } from "../../plugin-config/omo-config-chain"
import { canonicalJson, freezeSnapshot, sha256 } from "./protocol"
import { POLICY_LIMITS } from "./policy-schema"
import type { DeepReadonly } from "./types"

export type AutopilotAuthorityState = "enabled" | "operator_off" | "missing" | "invalid" | "withdrawn"
export interface AutopilotBinding {
  readonly state: AutopilotAuthorityState
  readonly errors: readonly string[]
  readonly workspace: string
  readonly enrollment?: DeepReadonly<AutopilotEnrollment>
  readonly limits: { readonly timeout_ms: number; readonly max_fallbacks: number; readonly max_file_bytes: number; readonly max_total_bytes: number; readonly max_sources: number }
  readonly config: DeepReadonly<Pick<OhMyOpenCodeConfig, "agents" | "categories" | "disabled_agents" | "disabled_skills" | "disabled_tools" | "disabled_providers">>
  readonly origins: Readonly<Record<string, string>>
  readonly sourceIdentity: string
}

const bindings = new WeakMap<object, AutopilotBinding>()

export function getAutopilotBinding(agents: object | undefined): AutopilotBinding | undefined {
  return agents === undefined ? undefined : bindings.get(agents)
}

/** Revocation identity excludes mutable behavioral text and model selection. */
export function autopilotAuthorityIdentity(binding: AutopilotBinding): string {
  const agent = binding.config.agents?.autopilot
  const category = agent?.category ? binding.config.categories?.[agent.category] : undefined
  return sha256(canonicalJson(JSON.parse(JSON.stringify({ state: binding.state, workspace: binding.workspace,
    enrollment: binding.enrollment ?? null, limits: binding.limits,
    tools: { ...category?.tools, ...agent?.tools }, permission: agent?.permission ?? {},
    disabledTools: binding.config.disabled_tools ?? [] }))))
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function canonicalEnrollment(entry: AutopilotEnrollment): AutopilotEnrollment {
  if (!path.isAbsolute(entry.workspace)) throw Error("invalid_workspace")
  const workspace = realpathSync(entry.workspace)
  const canonicalRoots = (values: string[]) => values.map(value => {
    if (/(^|[\\/])\.\.([\\/]|$)/.test(value)) throw Error("invalid_root")
    const resolved = path.resolve(workspace, value)
    const canonical = realpathSync(resolved)
    if ((!path.isAbsolute(value) && !within(workspace, resolved)) || path.relative(resolved, canonical) !== "") throw Error("invalid_root")
    return canonical
  })
  const policy_roots = canonicalRoots(entry.policy_roots)
  const manifest = path.resolve(workspace, entry.manifest)
  if (!policy_roots.some(root => within(root, manifest))) throw Error("invalid_manifest_root")
  return { ...entry, workspace, policy_roots, task_store_roots: canonicalRoots(entry.task_store_roots),
    evidence_roots: canonicalRoots(entry.evidence_roots), manifest }
}

/** Called only by the native validator, after preserving pre-prune diagnostics. */
export function bindAutopilotConfiguration(
  config: OhMyOpenCodeConfig,
  chain: OmoOpenCodeConfigChain,
  directory: string,
  rejectedPaths: readonly string[],
): AutopilotBinding {
  const errors: string[] = []
  const configured = chain.autopilotOperatorView.autopilot !== undefined || chain.views.some(view =>
    Object.hasOwn(view.config, "autopilot") || Object.keys(record(view.config.agents)).some(name => name.toLowerCase() === "autopilot"))
    || chain.diagnostics.some(item => "issuePaths" in item && item.issuePaths?.some(key => /(^|\.)autopilot(\.|$)/i.test(key)))
  const category = config.agents?.autopilot?.category
  const relevant = (key: string) => /(^|\.)(autopilot|models)(\.|$)/i.test(key)
    || /(^|\.)(agents|categories)$/.test(key)
    || (category !== undefined && key.includes(`categories.${category}`))
  for (const diagnostic of chain.diagnostics) {
    if (diagnostic.kind === "deprecated-keys") continue
    const keys = "issuePaths" in diagnostic ? diagnostic.issuePaths : undefined
    if (configured && (["read", "parse", "profile", "validation", "model_catalog_cycle"].includes(diagnostic.kind)
      || keys?.some(relevant) || ("key" in diagnostic && relevant(String(diagnostic.key))))) errors.push("native_source_invalid")
  }
  if (configured && rejectedPaths.some(relevant)) errors.push("native_value_invalid")
  const origins: Record<string, string> = {}
  for (const view of chain.views) {
    if (!view.scope) continue
    for (const [name, value] of Object.entries(record(view.config.agents))) {
      if (name.toLowerCase() !== "autopilot") continue
      if (name !== "autopilot" || !AutopilotAgentOverrideSchema.safeParse(value).success) errors.push("agent_invalid")
      for (const field of Object.keys(record(value))) origins[`agents.autopilot.${field}`] = `${view.path}#${view.keyPrefix}agents.autopilot.${field}`
    }
    if (category) for (const field of Object.keys(record(record(view.config.categories)[category]))) {
      origins[`categories.${category}.${field}`] = `${view.path}#${view.keyPrefix}categories.${category}.${field}`
    }
    if (Object.hasOwn(view.config, "autopilot") && !view.keyPrefix.endsWith("[opencode].")) errors.push("control_outside_harness")
    if (Object.hasOwn(view.config, "autopilot") && !AutopilotConfigSchema.safeParse(view.config.autopilot).success) errors.push("control_invalid")
  }
  let state: AutopilotAuthorityState = "missing"
  let enrollment: AutopilotEnrollment | undefined
  const limits: { timeout_ms: number; max_fallbacks: number; max_file_bytes: number; max_total_bytes: number; max_sources: number } = { timeout_ms: 120000, max_fallbacks: 1, max_file_bytes: POLICY_LIMITS.fileBytes,
    max_total_bytes: POLICY_LIMITS.totalBytes, max_sources: POLICY_LIMITS.sourceCount }
  let workspace = path.resolve(directory)
  try { workspace = realpathSync(directory) } catch { if (configured) errors.push("workspace_unavailable") }
  const raw = chain.autopilotOperatorView.autopilot
  const operator = raw === undefined ? undefined : AutopilotConfigSchema.safeParse(raw)
  if (operator && !operator.success) errors.push("operator_invalid")
  if (operator?.success) {
    const control = operator.data
    if (control.mode === undefined) errors.push("operator_mode_missing")
    state = control.mode === "off" ? "operator_off" : "missing"
    Object.assign(limits, control.limits)
    try {
      const candidates = (control.enrollments ?? []).map(canonicalEnrollment)
        .filter(entry => path.relative(entry.workspace, workspace) === ""
          && (control.enrollment_ids === undefined || control.enrollment_ids.includes(entry.id)))
      if (candidates.length > 1) errors.push("ambiguous_enrollment")
      enrollment = candidates[0]
      if (control.mode === "on" && enrollment) state = "enabled"
    } catch { errors.push("enrollment_invalid") }
  }
  for (const view of chain.views.filter(view => view.scope === "project" && Object.hasOwn(view.config, "autopilot"))) {
    const parsed = AutopilotConfigSchema.safeParse(view.config.autopilot)
    if (!parsed.success) { errors.push("project_control_invalid"); continue }
    const control = parsed.data
    if (control.enrollments !== undefined) errors.push("project_enrollment_forbidden")
    if (control.enrollment_ids?.some(id => !operator?.success || !operator.data.enrollments?.some(entry => entry.id === id))) errors.push("project_selection_invalid")
    if (control.mode === "on" && operator?.success && operator.data.mode !== "on") errors.push("project_activation_forbidden")
    if (control.mode === "off" || (control.enrollment_ids !== undefined && (!enrollment || !control.enrollment_ids.includes(enrollment.id)))) {
      if (state !== "operator_off") state = "withdrawn"
    }
    for (const [key, value] of Object.entries(control.limits ?? {})) {
      const limit = key as keyof typeof limits
      if (value > limits[limit]) errors.push("project_limit_expansion")
      else limits[limit] = value
    }
  }
  if (config.disabled_agents?.some(name => name.toLowerCase() === "autopilot") || config.agents?.autopilot?.disable) {
    if (state !== "operator_off") state = "withdrawn"
  }
  if (errors.length) state = "invalid"
  const categoryView = category && (config.categories?.[category] || chain.autopilotCategoryView)
    ? CategoryConfigSchema.safeParse({ ...config.categories?.[category], ...chain.autopilotCategoryView }) : undefined
  const projection = structuredClone({ agents: { autopilot: config.agents?.autopilot },
    categories: category && categoryView?.success ? { [category]: categoryView.data } : undefined,
    disabled_agents: config.disabled_agents, disabled_skills: config.disabled_skills,
    disabled_tools: config.disabled_tools, disabled_providers: config.disabled_providers })
  const binding = freezeSnapshot({ state, errors: [...new Set(errors)], workspace, enrollment, limits, config: projection,
    origins, sourceIdentity: sha256(canonicalJson({ sources: chain.sources, origins, operatorProfile: chain.autopilotOperatorProfile ?? null,
      state, enrollment: enrollment ?? null, limits })) })
  if (state === "enabled") config.agents ??= {}
  if (config.agents) bindings.set(config.agents, binding)
  bindings.set(config, binding)
  return binding
}
