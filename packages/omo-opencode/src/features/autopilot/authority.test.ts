import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validatePluginConfig } from "../../config/validate"
import { getAutopilotBinding } from "./authority"

function fixture(run: (value: {
  project: string
  control: Record<string, unknown>
  writeUser: (config: unknown) => void
  writeProject: (config: unknown) => void
  load: (profile?: string) => ReturnType<typeof validatePluginConfig>
}) => void): void {
  const root = mkdtempSync(join(tmpdir(), "autopilot-authority-"))
  const project = join(root, "project")
  for (const directory of [join(root, ".omo"), join(project, ".omo"), join(project, "policy"), join(project, "tasks"), join(project, "evidence")]) mkdirSync(directory, { recursive: true })
  const control = { format_version: "1", mode: "on", enrollments: [{ id: "workspace", workspace: project,
    task_store_roots: ["tasks"], policy_roots: ["policy"], evidence_roots: ["evidence"], manifest: "policy/manifest.json", sources: [] }] }
  const write = (directory: string, config: unknown) => writeFileSync(join(directory, ".omo", "omo.jsonc"), JSON.stringify(config))
  try { run({ project, control, writeUser: config => write(root, config), writeProject: config => write(project, config),
    load: profile => validatePluginConfig(project, { HOME: root, USERPROFILE: root, OMO_PROFILE: profile }) }) }
  finally { rmSync(root, { recursive: true, force: true }) }
}

describe("native Autopilot authority", () => {
  test("#given native operator enrollment #when loading #then only the original validated view carries authority", () => fixture(f => {
    f.writeUser({ "[opencode]": { autopilot: f.control } })
    const result = f.load()
    expect(result.valid).toBe(true)
    expect(getAutopilotBinding(result.config.agents)?.state).toBe("enabled")
    expect(getAutopilotBinding(structuredClone(result.config.agents))).toBeUndefined()
    expect(getAutopilotBinding({ autopilot: { trusted: true } })).toBeUndefined()
  }))

  test("#given absent authority and project enrollment #when loading #then it cannot enroll itself", () => fixture(f => {
    expect(getAutopilotBinding(f.load().config)?.state).toBe("missing")
    f.writeProject({ "[opencode]": { autopilot: f.control } })
    expect(getAutopilotBinding(f.load().config)?.state).toBe("invalid")
  }))

  test("#given operator on #when project withdraws or selects an empty subset #then neither means operator off", () => fixture(f => {
    f.writeUser({ "[opencode]": { autopilot: f.control } })
    for (const restriction of [{ mode: "off" }, { enrollment_ids: [] }]) {
      f.writeProject({ "[opencode]": { autopilot: { format_version: "1", ...restriction } } })
      expect(getAutopilotBinding(f.load().config)?.state).toBe("withdrawn")
    }
    f.writeProject({ "[opencode]": { autopilot: { format_version: "1", enrollment_ids: ["workspace"] } } })
    expect(getAutopilotBinding(f.load().config)?.state).toBe("enabled")
  }))

  test("#given operator off #when project enables mode #then it cannot activate", () => fixture(f => {
    f.writeUser({ "[opencode]": { autopilot: { ...f.control, mode: "off" } } })
    expect(getAutopilotBinding(f.load().config)?.state).toBe("operator_off")
    f.writeProject({ "[opencode]": { autopilot: { format_version: "1", mode: "on" } } })
    expect(getAutopilotBinding(f.load().config)?.state).toBe("invalid")
  }))

  test("#given operator limits #when project widens roots or limits or selects an unknown enrollment #then reject", () => fixture(f => {
    f.writeUser({ "[opencode]": { autopilot: { ...f.control, limits: { timeout_ms: 5000 } } } })
    for (const restriction of [{ enrollments: [] }, { limits: { timeout_ms: 5001 } }, { enrollment_ids: ["workspace", "invented"] }]) {
      f.writeProject({ "[opencode]": { autopilot: { format_version: "1", ...restriction } } })
      expect(getAutopilotBinding(f.load().config)?.state).toBe("invalid")
    }
    f.writeProject({ "[opencode]": { autopilot: { format_version: "1", limits: { timeout_ms: 3000, max_fallbacks: 0 } } } })
    expect(getAutopilotBinding(f.load().config)?.limits).toMatchObject({ timeout_ms: 3000, max_fallbacks: 0 })
  }))

  test("#given user profiles #when the host selects one #then authority uses only that user declaration", () => fixture(f => {
    f.writeUser({ "[opencode]": { autopilot: { ...f.control, mode: "off" }, mcp_env_allowlist: ["BASE"] },
      profiles: { review: { "[opencode]": { autopilot: f.control, mcp_env_allowlist: ["PROFILE"] } } } })
    f.writeProject({ profiles: { projectOnly: { "[opencode]": { autopilot: { format_version: "1", mode: "on" } } } } })
    expect(getAutopilotBinding(f.load().config)?.state).toBe("operator_off")
    expect(getAutopilotBinding(f.load("projectOnly").config)?.state).toBe("invalid")
    const selected = f.load("review")
    expect(getAutopilotBinding(selected.config)?.state).toBe("enabled")
    expect(selected.config.mcp_env_allowlist).toEqual(["PROFILE"])
  }))

  test("#given malformed explicit model or control #when pruning #then no valid fallback authority remains", () => fixture(f => {
    f.writeUser({ "[opencode]": { autopilot: f.control, agents: { autopilot: { model: "provider/good" } } } })
    for (const invalid of [{ model: 123 }, { models: [] }, { mode: "primary" }, { permission: { bash: "allow" } }, { trusted: true },
      { thinking: { type: "disabled", trusted: true } }, { models: [{ model: "provider/good", bypass: true }] }]) {
      f.writeProject({ "[opencode]": { agents: { autopilot: invalid } } })
      const result = f.load()
      expect(result.valid).toBe(false)
      expect(getAutopilotBinding(result.config)?.state).toBe("invalid")
    }
    f.writeProject({ "[opencode]": { autopilot: { format_version: "2", mode: "off" } } })
    expect(getAutopilotBinding(f.load().config)?.state).toBe("invalid")
  }))
})
