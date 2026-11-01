import { describe, expect, spyOn, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { refreshAutopilotNativeConfig, readAutopilotInstructionView } from "./native-config"
import type { EnrolledSource } from "./policy-snapshot"
import * as providerCache from "../../shared/connected-providers-cache"

async function fixture(run: (value: {
  project: string
  configPath: string
  write: (agent: Record<string, unknown>, extra?: Record<string, unknown>, sources?: EnrolledSource[], limits?: { max_fallbacks: number }) => void
  refresh: (available?: Set<string>, profile?: string) => ReturnType<typeof refreshAutopilotNativeConfig>
}) => Promise<void> | void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "autopilot-native-"))
  const project = join(root, "project")
  const configPath = join(root, ".omo", "omo.jsonc")
  for (const directory of [join(root, ".omo"), join(project, "policy"), join(project, "tasks"), join(project, "evidence")]) mkdirSync(directory, { recursive: true })
  const write = (agent: Record<string, unknown>, extra: Record<string, unknown> = {}, sources: EnrolledSource[] = [], limits?: { max_fallbacks: number }) => writeFileSync(configPath, JSON.stringify({
    "[opencode]": { autopilot: { format_version: "1", mode: "on", ...(limits ? { limits } : {}), enrollments: [{ id: "workspace", workspace: project,
      task_store_roots: ["tasks"], policy_roots: ["policy"], evidence_roots: ["evidence"], manifest: "policy/manifest.json", sources }] }, agents: { autopilot: agent } }, ...extra,
  }))
  try { await run({ project, configPath, write, refresh: (available = new Set(["provider/default", "provider/direct", "provider/category", "provider/fallback"]), profile) =>
    refreshAutopilotNativeConfig(project, { availableModels: available, systemDefaultModel: "provider/default" }, { HOME: root, USERPROFILE: root, OMO_PROFILE: profile }) }) }
  finally { rmSync(root, { recursive: true, force: true }) }
}

describe("Autopilot native refresh", () => {
  test("#given no explicit model #when resolving #then native system default works without a provider prerequisite", () => fixture(f => {
    f.write({})
    const value = f.refresh()
    expect(value.agent.model).toBe("provider/default")
    expect(value.agent.mode).toBe("subagent")
    expect(value.allowedTools).toEqual([])
    expect(value.agent.permission).toMatchObject({ "*": "deny", external_directory: "deny" })
  }))

  test("#given category and direct models list #when refreshing #then materialized primary and reasoning win", () => fixture(f => {
    f.write({ category: "review", model: "provider/direct", reasoning: "low", models: [{ model: "provider/default", reasoning: "max" }, "provider/fallback"] },
      { categories: { review: { model: "provider/category", reasoning: "medium" } } })
    const value = f.refresh()
    expect(value.models).toEqual([{ model: "provider/default", reasoning: "max" }, { model: "provider/fallback" }])
    expect(value.agent.variant).toBe("max")
  }))

  test("#given native profile and catalog alias #when selected #then the ordinary loader resolves them", () => fixture(f => {
    f.write({ model: "provider/direct" }, { models: { chosen: { model: "provider/default", reasoning: "high" } },
      profiles: { review: { "[opencode]": { agents: { autopilot: { model: "chosen" } } } } } })
    expect(f.refresh(undefined, "review").agent).toMatchObject({ model: "provider/default", variant: "high" })
  }))

  test("R1-category-unavailable #given unavailable explicit category and available default #when refreshing #then reject before admission", () => fixture(f => {
    f.write({ category: "review" }, { categories: { review: { model: "provider/missing" } } }, [], { max_fallbacks: 0 })
    expect(() => f.refresh()).toThrow("invalid_configuration")
  }))

  test.each(["direct", "category"] as const)("R1-explicit-%s #given an eligible built-in alternative but no declared fallback #when refreshing #then capture only the selected primary", selection => fixture(f => {
    f.write(selection === "direct" ? { model: "provider/direct" } : { category: "review" },
      { categories: { review: { model: "provider/direct" } } })
    const value = f.refresh(new Set(["provider/default", "provider/direct", "openai/gpt-6-astra"]))
    expect(value.models.map(entry => entry.model)).toEqual(["provider/direct"])
    expect(value.agent.fallback_models).toEqual([])
  }))

  test.each([
    { id: "valid-category", agent: { category: "review", fallback_models: [] }, category: { model: "provider/category" }, expected: ["provider/category"] },
    { id: "direct-over-category", agent: { model: "provider/direct", category: "review", fallback_models: [] }, category: { model: "provider/missing" }, expected: ["provider/direct"] },
    { id: "declared-direct", agent: { model: "provider/direct", fallback_models: ["provider/fallback"] }, category: {}, expected: ["provider/direct", "provider/fallback"] },
    { id: "declared-category", agent: { category: "review" }, category: { model: "provider/category", fallback_models: ["provider/fallback"] }, expected: ["provider/category", "provider/fallback"] },
    { id: "empty-chain", agent: { model: "provider/direct", fallback_models: [] }, category: {}, expected: ["provider/direct"] },
    { id: "single-models-entry", agent: { models: ["provider/direct"] }, category: {}, expected: ["provider/direct"] },
    { id: "zero-cap", agent: { model: "provider/direct", fallback_models: ["provider/fallback"] }, category: {}, cap: 0, expected: ["provider/direct"] },
  ])("R1-control-$id #given native selection boundaries #when refreshing #then preserve the declared chain", row => fixture(f => {
    f.write(row.agent, { categories: { review: row.category } }, [], row.cap === undefined ? undefined : { max_fallbacks: row.cap })
    const value = f.refresh(new Set(["provider/default", "provider/direct", "provider/category", "provider/fallback", "openai/gpt-6-astra"]))
    expect(value.models.map(entry => entry.model)).toEqual(row.expected)
  }))

  test("R1-control-default-chain #given no explicit primary and two eligible native defaults #when refreshing #then preserve the built-in fallback", () => fixture(f => {
    f.write({})
    const value = f.refresh(new Set(["openai/gpt-6-astra", "anthropic/claude-opus-5-5"]))
    expect(value.models.map(entry => entry.model)).toEqual(["openai/gpt-6-astra", "anthropic/claude-opus-5-5"])
  }))

  test("R5-compatibility #given native reasoning aliases #when refreshed #then canonical reasoning and native effort precedence remain", () => fixture(f => {
    for (const [settings, expected] of [
      [{ variant: "high" }, "high"],
      [{ reasoningEffort: "high" }, "high"],
      [{ reasoning: "high", variant: "low", reasoningEffort: "low" }, "high"],
      [{ variant: "high", reasoningEffort: "low" }, "low"],
      [{ reasoning: "max", variant: "high", reasoningEffort: "low" }, "max"],
    ] as const) {
      f.write({ model: "provider/direct", ...settings })
      expect(f.refresh().agent.variant).toBe(expected)
    }
  }))

  test.each([
    { reasoning: "not-supported" },
    { variant: "not-supported" },
    { reasoning: "max", fallback_models: [{ model: "provider/fallback", variant: "not-supported" }] },
  ])("#given unsupported custom reasoning %j #when projecting #then reject before child admission", settings => fixture(f => {
    const metadata = spyOn(providerCache, "findProviderModelMetadata").mockImplementation((_provider, id) => ({
      id, variants: { high: {}, max: {}, deliberate: {} },
    }))
    try {
      f.write({ model: "provider/direct", ...settings })
      expect(() => f.refresh()).toThrow("invalid_configuration")
    } finally { metadata.mockRestore() }
  }))

  test("#given custom reasoning without native metadata #when projecting #then unverifiable support is rejected", () => fixture(f => {
    const metadata = spyOn(providerCache, "findProviderModelMetadata").mockReturnValue(undefined)
    try {
      f.write({ model: "provider/direct", reasoning: "deliberate" })
      expect(() => f.refresh()).toThrow("invalid_configuration")
    } finally { metadata.mockRestore() }
  }))

  test("#given a declared native custom variant #when projecting reasoning or variant #then passthrough remains supported", () => fixture(f => {
    const metadata = spyOn(providerCache, "findProviderModelMetadata").mockImplementation((_provider, id) => ({
      id, variants: { high: {}, max: {}, deliberate: {} },
    }))
    try {
      for (const settings of [{ reasoning: "deliberate" }, { variant: "deliberate" }]) {
        f.write({ model: "provider/direct", ...settings })
        expect(f.refresh().agent.variant).toBe("deliberate")
      }
    } finally { metadata.mockRestore() }
  }))

  test("#given a captured A #when native model changes and reverts #then fresh identities change while A stays frozen", () => fixture(f => {
    f.write({ model: "provider/direct" })
    const a = f.refresh()
    f.write({ model: "provider/default" })
    const b = f.refresh()
    f.write({ model: "provider/direct" })
    const reverted = f.refresh()
    expect(a.agent.model).toBe("provider/direct")
    expect(b.configurationDigest).not.toBe(a.configurationDigest)
    expect(reverted.configurationDigest).toBe(a.configurationDigest)
    expect(Object.isFrozen(a.agent)).toBe(true)
  }))

  test("#given explicit unavailable models or unsafe tools #when refreshed #then no alternate authority is selected", () => fixture(f => {
    for (const agent of [{ model: "provider/missing" }, { model: "provider/direct", tools: { bash: true } }, { permission: { "*": "allow" } },
      { permission: { external_directory: "allow" } }, { mode: "primary" }, { providerOptions: { arbitrary: true } }]) {
      f.write(agent)
      expect(() => f.refresh()).toThrow("invalid_configuration")
    }
  }))

  test("#given requested search tools #when native permission narrows them #then fixed wildcard and secret denials remain", () => fixture(f => {
    f.write({ model: "provider/direct", tools: { read: true, grep: true }, permission: { read: "deny", grep: "ask" } })
    const value = f.refresh()
    expect(value.allowedTools).toEqual(["grep"])
    expect(value.agent.tools).toEqual({ "*": false, grep: true })
    expect(value.agent.permission).toMatchObject({ "*": "deny", external_directory: "deny", read: "deny", grep: { "*": "deny", "**/.env*": "deny" } })
  }))

  test("#given enrolled missing prompt files #when projecting #then descriptors are captured without reading payloads", () => fixture(f => {
    const file = join(f.project, "policy", "not-created.md")
    const source: EnrolledSource = { id: "prompt", channel: "prompt", kind: "file", source: file }
    f.write({ prompt: pathToFileURL(file).href }, {}, [source])
    expect(f.refresh().sources).toEqual([source])
    f.write({ prompt: pathToFileURL(file).href })
    expect(() => f.refresh()).toThrow("source_unenrolled")
  }))

  test("#given enrolled inline native channels #when refreshed #then exact origin and bytes are bound", () => fixture(f => {
    const source: EnrolledSource = { id: "append", channel: "prompt_append", kind: "inline", source: `${f.configPath}#[opencode].agents.autopilot.prompt_append` }
    f.write({ prompt_append: "fixture A" }, {}, [source])
    const a = f.refresh()
    f.write({ prompt_append: "fixture B" }, {}, [source])
    const b = f.refresh()
    expect(a.sources).toEqual([{ ...source, text: "fixture A" }])
    expect(b.sources).toEqual([{ ...source, text: "fixture B" }])
    expect(b.configurationDigest).not.toBe(a.configurationDigest)
  }))

  test("#given an enrolled skill #when projecting then capturing #then expansion happens only after preflight", () => fixture(async f => {
    const source: EnrolledSource = { id: "review-skill", channel: "skill", kind: "inline", source: join(f.project, "policy", "SKILL.md") }
    f.write({ skills: ["review-skill"] }, {}, [source])
    const value = f.refresh()
    expect(value.deferredSkills).toEqual([{ name: "review-skill", source }])
    let reads = 0
    const view = await readAutopilotInstructionView(value, async (descriptor, name) => {
      reads++
      expect(descriptor.source).toBe(source.source)
      expect(name).toBe("review-skill")
      return "captured expanded fixture"
    })
    expect(reads).toBe(1)
    expect(view.sources).toEqual([{ ...source, text: "captured expanded fixture" }])
    f.write({ skills: ["unenrolled"] }, {}, [source])
    expect(() => f.refresh()).toThrow("source_unenrolled")
    expect(reads).toBe(1)
  }))
})
