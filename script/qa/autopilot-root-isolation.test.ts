import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises"
import path from "node:path"
import { parseArgs } from "node:util"
import { pathToFileURL } from "node:url"
import { check, digest, Evidence, object } from "./autopilot-evidence"
import type { Data } from "./autopilot-evidence"
import { Fixtures } from "./autopilot-fixtures"
import { toolCases } from "./autopilot-negative-cases"
import type { Context } from "./autopilot-host"
import { createSubagentDescendantLimitError, getMaxLiveDescendantsPerRoot } from "../../packages/omo-opencode/src/features/background-agent/subagent-spawn-limits"

const repo = path.resolve(import.meta.dir, "../..")
const owner = path.join(repo, ".omo/evidence/20261030-omo-ap-002-01/workers/qa-root-budget-confirmed-repair-01")
type Fault = "none" | "subject" | "evidence" | "task" | "second-start" | "second-create" | "restart" | "stop"

async function drive(fault: Fault = "none") {
  await mkdir(path.join(owner, "units"), { recursive: true })
  const directory = await mkdtemp(path.join(owner, "units", "run-"))
  const fixtures: Fixtures[] = [], hosts: ControlledHost[] = [], writes: string[] = [], calls: Data[] = [], groups: string[] = []
  const provider = { url: "http://127.0.0.1:1", records: [] as Data[], stopped: false, stop() { this.stopped = true } }
  const runtime = { cwd: () => repo, platform: process.platform, arch: process.arch, exitCode: 0 }
  let nextChild = 0, mutationDone = false
  const max = getMaxLiveDescendantsPerRoot()
  class ControlledHost {
    readonly events: Data[] = []
    readonly observations: Data[] = [{ case_id: "before-stop", fixture: fixtures.length }]
    readonly process = { pid: hosts.length + 1 }
    readonly nativeAgent = "autopilot"
    readonly ordinaryAgent = "explore"
    used = 0
    stopped = false
    constructor(readonly fixture: Fixtures, readonly parent: string) { hosts.push(this) }
    async invoke(scenario: { id: string; arguments?: Data }): Promise<Data> {
      const task = JSON.parse(await readFile(path.join(this.fixture.workspace, "tasks/task1.json"), "utf8"))
      check(task.threadID === this.parent, "test_task_parent_changed")
      if (scenario.id === "policy-permission-override") return { outcome: "human_required", error: "policy_mismatch" }
      if (this.used >= max) {
        const error = createSubagentDescendantLimitError({ descendantCount: this.used, maxDescendants: max,
          parentSessionID: this.parent, rootSessionID: this.parent })
        calls.push({ id: scenario.id, parent: this.parent, used: this.used, child: false, limit_error: error.message })
        return { outcome: "human_required", error: "native_result_invalid" }
      }
      this.used += 1
      const child = `child-${++nextChild}`
      calls.push({ id: scenario.id, parent: this.parent, used: this.used, child: true })
      provider.records.push({ case_id: scenario.id, invocation_id: child, model: "judge" })
      if (scenario.id.startsWith("tool-")) this.events.push({ type: "message.part.updated", properties: { part: {
        type: "tool", callID: `probe_${scenario.id}`, tool: scenario.id === "tool-bash" ? "bash" : "read",
        state: { status: scenario.id === "tool-read" ? "completed" : "error" },
      } } })
      return { decision: { outcome: "approve" }, provenance: { child_session_id: child }, parent: this.parent }
    }
    async verify(result: Data) { check(result.parent === this.parent, "test_child_parent_changed"); return result }
    async diagnosticMessages() { return [{ parent_session_id: this.parent }] }
    async stop(): Promise<Data> {
      this.stopped = true
      this.observations.length = 0
      if (fault === "stop" && this === hosts[0]) throw new Error("controlled_stop_failure")
      return { process_exited: true, sse_closed: true, event_counts: {} }
    }
  }
  const factory = {
    async create(_repo: string, created?: (fixture: Fixtures) => void) {
      const root = await mkdtemp(path.join(directory, "omo-autopilot-qa-")), fixture = new Fixtures(await realpath(root))
      fixtures.push(fixture); created?.(fixture)
      if (fault === "second-create" && fixtures.length === 2) throw new Error("controlled_fixture_setup_failure")
      for (const dir of ["home/.omo", "home/workspace/.omo", "home/workspace/policy", "home/workspace/tasks", "home/workspace/evidence", "config/opencode"]) {
        await mkdir(path.join(root, dir), { recursive: true })
      }
      await writeFile(path.join(fixture.workspace, "evidence/subject.md"), "bounded synthetic subject")
      await writeFile(path.join(fixture.workspace, "evidence/check.json"), '{"exit":0}')
      const task = fixture.task.bind(fixture)
      fixture.task = async parent => { writes.push(parent); await task(parent) }
      await fixture.reset()
      return fixture
    },
  }
  const hostFactory = {
    async start(fixture: Fixtures, _provider: unknown, _binary: string, _version: string, retained?: string, failed?: (receipt: Data) => void) {
      if ((fault === "second-start" && fixtures.length === 2) || (fault === "restart" && retained)) {
        failed?.({ process_exited: true, sse_closed: true, process_started: true })
        throw new Error("controlled_host_setup_failure")
      }
      const parent = retained ?? `parent-${fixtures.length}`
      if (!retained) await fixture.task(parent)
      else check(JSON.parse(await readFile(path.join(fixture.workspace, "tasks/task1.json"), "utf8")).threadID === parent, "test_restart_rewrote_parent")
      return new ControlledHost(fixture, parent)
    },
  }
  const allocate = async (context: Context, ids: string[]) => {
    for (const id of ids) await context.host.invoke({ id, arguments: context.fixture.arguments() })
    return {}
  }
  class CapturedEvidence extends Evidence {
    override async run(id: string, action: () => Promise<Data>) {
      groups.push(id)
      await super.run(id, async () => {
        const result = await action()
        if (!mutationDone && id === "malformed-result" && ["subject", "evidence", "task"].includes(fault)) {
          mutationDone = true
          const relative = fault === "task" ? "tasks/task1.json" : fault === "subject" ? "evidence/subject.md" : "evidence/check.json"
          await writeFile(path.join(fixtures[0].workspace, relative), "changed-after-baseline")
        }
        return result
      })
    }
  }
  const helper = path.join(repo, "script/qa/autopilot-root-isolation.ts")
  const bindings = {
    readFile: async (file: string) => file.endsWith("package.json") ? '{"version":"1.18.31"}' : Buffer.from("frozen-test-bundle"),
    realpath, path, parseArgs, check, digest, object, Evidence: CapturedEvidence, Fixtures: factory, Host: hostFactory,
    realSessionCount: () => ({ path: "controlled-unopened-db", exists: false, count: 0 }), startProvider: () => provider,
    verifyManifest: async () => "controlled-source-binding", RootIsolation: existsSync(helper) ? (await import(pathToFileURL(helper).href)).RootIsolation : undefined,
    modelPolicyCases: (context: Context) => allocate(context, ["model-A", "model-B", "model-revert"]),
    policyNegativeCases: async () => ({}), offCases: async () => ({}), agent: () => undefined,
    nativeConfigCases: (context: Context) => allocate(context, ["user-model", "project-model", "profile-model", "category-model", "direct-over-category",
      "catalog-alias", "models-list", "variant-alias", "effort-alias", "alias-collision", "canonical-over-aliases", "native-default-builtin", "custom-variant"]),
    fallbackCase: (context: Context) => allocate(context, ["fallback", "explicit-direct", "explicit-category", "explicit-declared-builtin"]),
    ordinaryCase: (context: Context) => allocate(context, ["ordinary"]),
    lifecycleCases: async (context: Context, primary: Data) => { check(primary.parent === context.host.parent, "test_lifecycle_parent_changed"); return {} },
    malformedCase: (context: Context) => allocate(context, ["malformed"]), toolCases,
    cancellationCase: (context: Context) => allocate(context, ["cancel"]),
    deadlineRecoveryCases: (context: Context) => allocate(context, ["short-user", "recover-user", "short-project", "recover-project"]),
    childDeletionCase: (context: Context) => allocate(context, ["delete-child", "delete-recovery"]),
    historyRestartCase: async (context: Context, restart: (name: string) => Promise<ControlledHost>) => {
      const parent = context.host.parent, identity = await context.fixture.contentIdentity()
      await restart("old-review-name"); await allocate(context, ["custom-name-producer"])
      await restart("New Gate"); await allocate(context, ["copied-producer-data"])
      check(context.host.parent === parent && JSON.stringify(await context.fixture.contentIdentity()) === JSON.stringify(identity), "test_restart_identity_changed")
      return { retained_parent: parent }
    },
    Bun: { argv: ["bun", "driver", "--mode", "real", "--evidence-dir", directory, "--producer-manifest", "controlled-product",
      "--driver-manifest", "controlled-driver", "--backend-url", "http://127.0.0.1:1", "--opencode-bin", "never-spawned"], spawnSync: () => ({ exitCode: 0 }) },
    process: runtime, console: { log: () => undefined },
  }
  // Execute the actual CLI orchestration body; only its external ports are supplied.
  // Capacity is a controlled reservation counter, not a native OpenCode/model proof.
  const target = process.env.OMO_AP002_ROOT_DRIVER_SOURCE ?? path.join(repo, "script/qa/autopilot.ts")
  const source = (await readFile(target, "utf8")).replace(/^#!.*\r?\n/, "").replace(/^import .*\r?\n/gm, "")
    .replace(/^if \(import.meta.main\) await main\(\)\s*$/m, "")
  const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(source)
  await new Function(...Object.keys(bindings), compiled + "\nreturn main()")(...Object.values(bindings))
  const result = object(JSON.parse(await readFile(path.join(directory, "result.json"), "utf8")))
  return { result, fixtures, hosts, writes, calls, groups, max, provider, exit: runtime.exitCode }
}

describe("QA-ROOT-BUDGET-01 actual driver fixture lifetime", () => {
  test("#given default24 and the confirmed load #when all groups run #then outside child is reached with independent roots", async () => {
    const run = await drive()
    console.log(JSON.stringify({ capacity: run.max, outside: run.calls.find(call => call.id === "tool-outside"),
      used: run.hosts.map(host => host.used), groups: run.groups, fatal: run.result.fatal_error ?? null }))
    expect(run.max).toBe(24)
    expect(run.calls.find(call => call.id === "tool-outside")?.child).toBe(true)
    expect(run.exit).toBe(0)
    expect(run.groups).toHaveLength(14)
    expect(run.result.acceptance).toHaveLength(11)
    expect(run.hosts[0].used).toBe(23)
    expect(run.hosts.every(host => host.used <= 24 && host.stopped)).toBe(true)
    expect(run.fixtures).toHaveLength(2)
    expect(new Set(run.writes).size).toBe(2)
    expect(run.writes).toHaveLength(2)
    const firstParent = run.calls.find(call => call.id === "initial")?.parent
    expect(run.calls.filter(call => ["model-A", "model-B", "model-revert", "malformed"].includes(String(call.id))).every(call => call.parent === firstParent)).toBe(true)
    expect(run.calls.find(call => call.id === "tool-outside")?.parent).not.toBe(firstParent)
    const receipts = run.result.fixtures as Data[]
    expect(receipts).toHaveLength(2)
    for (const receipt of receipts) {
      expect(receipt.before).toEqual(receipt.after)
      expect(receipt.no_effect).toBe(true)
      expect(object(receipt.cleanup).temporary_root_removed).toBe(true)
    }
    expect(run.result.native_observations).toHaveLength(run.hosts.length)
    expect(object(run.result.real_db).unchanged).toBe(true)
    expect(run.fixtures.every(fixture => !existsSync(fixture.root))).toBe(true)
    expect(run.provider.stopped).toBe(true)
  })
  for (const fault of ["subject", "evidence", "task"] as const) test(`#given changed ${fault} #when first fixture ends #then reject effects before new root and clean up`, async () => {
    const run = await drive(fault)
    expect(run.exit).toBe(1)
    expect(run.result.fatal_error).toBe("task_store_effect_detected")
    expect(run.fixtures).toHaveLength(1)
    expect(object((run.result.fixtures as Data[])[0]).no_effect).toBe(false)
    expect(run.fixtures.every(fixture => !existsSync(fixture.root))).toBe(true)
  })
  for (const fault of ["second-start", "second-create", "restart"] as const) test(`#given ${fault} fails #when unwinding #then retain every fixture receipt and clean partial setup`, async () => {
    const run = await drive(fault)
    expect(run.exit).toBe(1)
    expect(run.result.fatal_error).toBe(fault === "second-create" ? "controlled_fixture_setup_failure" : "controlled_host_setup_failure")
    expect(run.fixtures).toHaveLength(2)
    expect(run.fixtures.every(fixture => !existsSync(fixture.root))).toBe(true)
    expect(run.hosts.every(host => host.stopped)).toBe(true)
    const receipts = run.result.fixtures as Data[]
    expect(receipts).toHaveLength(2)
    expect(receipts.every(receipt => object(receipt.cleanup).temporary_root_removed === true)).toBe(true)
    expect(object(receipts[0]).no_effect).toBe(true)
    if (fault !== "second-create") expect(receipts[1].startup_cleanup).toEqual([{ process_exited: true, sse_closed: true, process_started: true }])
  })
  test("#given stop failure #when first fixture ends #then fail closed while removing its fixture", async () => {
    const run = await drive("stop")
    expect(run.exit).toBe(1)
    expect(run.fixtures).toHaveLength(1)
    expect(run.fixtures.every(fixture => !existsSync(fixture.root))).toBe(true)
    expect(object((run.result.fixtures as Data[])[0]).cleanup_failed).toBe(true)
  })
})
