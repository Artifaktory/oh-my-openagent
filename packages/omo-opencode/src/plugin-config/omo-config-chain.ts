import { isPlainRecord } from "@oh-my-opencode/utils"
import {
  loadOmoConfig,
  mergeOmoConfigRecords,
  OmoConfigSchema,
  pruneInvalidConfigPaths,
  type OmoConfigDiagnostic,
  type OmoConfigEnv,
  type OmoModelReferenceDiagnostic,
  resolveModelReferences,
  resolveOmoConfigView,
  resolveOmoProfileName,
} from "@oh-my-opencode/omo-config-core"

export type OmoOpenCodeConfigView = {
  readonly config: Record<string, unknown>
  /** Where the view sits in its file (`[opencode].`, `profiles.<P>.`), so a diagnostic names the full key. */
  readonly keyPrefix: string
  readonly path: string
  readonly scope?: "project" | "user"
}

export type OmoOpenCodeConfigChain = {
  readonly diagnostics: readonly (OmoConfigDiagnostic | OmoModelReferenceDiagnostic)[]
  readonly protectedUserView: Record<string, unknown>
  readonly views: readonly OmoOpenCodeConfigView[]
  readonly autopilotOperatorView: Record<string, unknown>
  readonly autopilotOperatorProfile?: string
  readonly autopilotCategoryView?: Record<string, unknown>
  readonly sources: ReturnType<typeof loadOmoConfig>["sources"]
}

const NON_PLUGIN_FIELDS = new Set(["legacy_migrations", "models", "task", "teams"])

function block(config: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const value = config["[opencode]"]
  return isPlainRecord(value) ? value : {}
}

function profile(config: Readonly<Record<string, unknown>>, name: string | undefined): Record<string, unknown> {
  if (name === undefined) return {}
  const profiles = config.profiles
  if (!isPlainRecord(profiles)) return {}
  const selected = profiles[name]
  return isPlainRecord(selected) ? selected : {}
}

function baseView(config: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config)) {
    if (key === "profiles" || (key.startsWith("[") && key.endsWith("]")) || NON_PLUGIN_FIELDS.has(key)) continue
    result[key] = value
  }
  return result
}

function appendViews(
  views: OmoOpenCodeConfigView[],
  layers: ReturnType<typeof loadOmoConfig>["layers"],
  select: (config: Readonly<Record<string, unknown>>) => Record<string, unknown>,
  keyPrefix: string,
): void {
  for (const layer of layers) {
    const config = select(layer.config)
    if (Object.keys(config).length > 0) views.push({ config, keyPrefix, path: layer.source.path, scope: layer.source.scope })
  }
}

function recordFields(value: unknown, fields: readonly string[]): Record<string, unknown> | undefined {
  if (!isPlainRecord(value)) return undefined
  const result: Record<string, unknown> = {}
  for (const field of fields) {
    if (field in value) result[field] = value[field]
  }
  return Object.keys(result).length > 0 ? result : undefined
}

function modelInput(view: Readonly<Record<string, unknown>>, nativeCategory = false): Record<string, unknown> {
  const autopilot = isPlainRecord(view.agents) && isPlainRecord(view.agents.autopilot) ? view.agents.autopilot : undefined
  const autopilotCategory = typeof autopilot?.category === "string" ? autopilot.category : undefined
  const agents = isPlainRecord(view.agents)
    ? Object.fromEntries(Object.entries(view.agents).flatMap(([name, definition]) => {
      const fields = recordFields(definition, ["description", "prompt", "model", "models", "models_distribution", "variant", "reasoningEffort", "tools", "temperature", "disable",
        ...(name === "autopilot" ? ["reasoning"] : [])])
      return fields === undefined ? [] : [[name, fields]]
    }))
    : undefined
  const categories = isPlainRecord(view.categories)
    ? Object.fromEntries(Object.entries(view.categories).flatMap(([name, definition]) => {
      const fields = recordFields(definition, ["description", "model", "models", "models_distribution", "fallback_models", "variant", "temperature", "top_p", "maxTokens", "thinking", "reasoningEffort", "textVerbosity", "tools", "prompt_append", "max_prompt_tokens", "is_unstable_agent", "disable",
        ...(nativeCategory && name === autopilotCategory ? ["reasoning"] : [])])
      return fields === undefined ? [] : [[name, fields]]
    }))
    : undefined

  return {
    ...(isPlainRecord(view.models) ? { models: view.models } : {}),
    ...(agents === undefined ? {} : { agents }),
    ...(categories === undefined ? {} : { categories }),
  }
}

function modelView(view: Readonly<Record<string, unknown>>, nativeCategory = false): {
  readonly config: Record<string, unknown>
  readonly diagnostics: readonly (OmoModelReferenceDiagnostic | OmoConfigDiagnostic)[]
} {
  const input = modelInput(view, nativeCategory)
  const parsed = OmoConfigSchema.safeParse(input)
  const autopilotDiagnostics: OmoConfigDiagnostic[] = parsed.success || !isPlainRecord(input.agents) || !Object.hasOwn(input.agents, "autopilot") ? [] : parsed.error.issues
    .filter(issue => issue.path[0] === "models" || issue.path[0] === "categories"
      || (issue.path[0] === "agents" && issue.path[1] === "autopilot"))
    .map(issue => ({ kind: "invalid-value", path: "(model overlay)", message: "Invalid Autopilot model input",
      issuePaths: [issue.path.map(String).join(".")] }))
  const modelConfig = parsed.success
    ? parsed.data
    : (() => {
      const pruned = pruneInvalidConfigPaths(input, parsed.error.issues, (record) => {
        const validation = OmoConfigSchema.safeParse(record)
        return validation.success ? { success: true } : { success: false, issues: validation.error.issues }
      })
      if (!pruned.ok) return undefined
      const validation = OmoConfigSchema.safeParse(pruned.config)
      return validation.success ? validation.data : undefined
    })()
  if (modelConfig === undefined) return { config: {}, diagnostics: autopilotDiagnostics }

  const resolved = resolveModelReferences(modelConfig)
  return {
    config: {
      ...(resolved.view.agents === undefined ? {} : { agents: resolved.view.agents }),
      ...(resolved.view.categories === undefined ? {} : { categories: resolved.view.categories }),
    },
    diagnostics: [...autopilotDiagnostics, ...resolved.diagnostics],
  }
}

export function loadOmoOpenCodeConfigChain(
  directory: string,
  environment: OmoConfigEnv = process.env,
): OmoOpenCodeConfigChain {
  const loaded = loadOmoConfig({ cwd: directory, env: environment })
  const merged = loaded.layers.reduce<Record<string, unknown>>(
    (config, layer) => mergeOmoConfigRecords(config, layer.config),
    {},
  )
  const resolved = resolveOmoConfigView({
    config: merged,
    harness: "opencode",
    ...(loaded.profile === undefined ? {} : { profile: loaded.profile }),
  })
  const views: OmoOpenCodeConfigView[] = []
  const selectedProfile = loaded.profile

  const profilePrefix = selectedProfile === undefined ? "" : `profiles.${selectedProfile}.`
  appendViews(views, loaded.layers, baseView, "")
  appendViews(views, loaded.layers, block, "[opencode].")
  appendViews(views, loaded.layers, (config) => baseView(profile(config, selectedProfile)), profilePrefix)
  appendViews(views, loaded.layers, (config) => block(profile(config, selectedProfile)), `${profilePrefix}[opencode].`)

  const resolvedModels = modelView(resolved.config)
  const nativeAgent = isPlainRecord(resolved.config.agents) && isPlainRecord(resolved.config.agents.autopilot)
    ? resolved.config.agents.autopilot : undefined
  const nativeModels: ReturnType<typeof modelView> = nativeAgent === undefined ? { config: {}, diagnostics: [] } : modelView(resolved.config, true)
  const nativeCategories = isPlainRecord(nativeModels.config.categories) ? nativeModels.config.categories : {}
  const autopilotCategoryView = typeof nativeAgent?.category === "string" && isPlainRecord(nativeCategories[nativeAgent.category])
    ? nativeCategories[nativeAgent.category] as Record<string, unknown> : undefined
  if (Object.keys(resolvedModels.config).length > 0) {
    const source = loaded.layers[0]?.source.path ?? directory
    views.push({ config: resolvedModels.config, keyPrefix: "", path: source })
  }

  let protectedUserView: Record<string, unknown> = {}
  for (const layer of loaded.layers) {
    if (layer.source.scope !== "user") continue
    protectedUserView = mergeOmoConfigRecords(protectedUserView, block(layer.config))
  }
  for (const layer of loaded.layers) {
    if (layer.source.scope !== "user") continue
    protectedUserView = mergeOmoConfigRecords(protectedUserView, block(profile(layer.config, selectedProfile)))
  }

  // Autopilot authority selects only a host-selected profile declared in user layers.
  // Keep the existing selector for the unrelated protected MCP/browser fields.
  const requestedOperatorProfile = resolveOmoProfileName({ env: environment })
  const userLayers = loaded.layers.filter(layer => layer.source.scope === "user")
  const autopilotOperatorProfile = requestedOperatorProfile !== undefined && userLayers.some(layer =>
    isPlainRecord(layer.config.profiles) && isPlainRecord(layer.config.profiles[requestedOperatorProfile]))
    ? requestedOperatorProfile : undefined
  let autopilotOperatorView: Record<string, unknown> = {}
  for (const layer of userLayers) autopilotOperatorView = mergeOmoConfigRecords(autopilotOperatorView, block(layer.config))
  for (const layer of userLayers) autopilotOperatorView = mergeOmoConfigRecords(autopilotOperatorView, block(profile(layer.config, autopilotOperatorProfile)))

  return {
    diagnostics: [
      ...loaded.diagnostics,
      ...resolvedModels.diagnostics,
      ...nativeModels.diagnostics.filter(diagnostic => diagnostic.issuePaths?.some(key => key.includes("categories."))),
    ],
    protectedUserView,
    autopilotOperatorView,
    autopilotOperatorProfile,
    autopilotCategoryView,
    sources: loaded.sources,
    views,
  }
}
