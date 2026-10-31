#!/usr/bin/env bun
import { readFile, realpath } from "node:fs/promises"
import path from "node:path"
import { parseArgs } from "node:util"
import { check, digest, Evidence, object, verifyManifest } from "./autopilot-evidence"
import type { Data } from "./autopilot-evidence"
import { Fixtures } from "./autopilot-fixtures"
import { Host, realSessionCount } from "./autopilot-host"
import { startProvider } from "./autopilot-provider"
import type { Provider } from "./autopilot-provider"
import { modelPolicyCases, policyNegativeCases } from "./autopilot-policy-cases"
import { nativeConfigCases, fallbackCase, offCases, ordinaryCase } from "./autopilot-config-cases"
import { cancellationCase, lifecycleCases, malformedCase, toolCases } from "./autopilot-negative-cases"

async function main(): Promise<void> {
  const { values } = parseArgs({ args: Bun.argv.slice(2), strict: true, options: {
    help: { type: "boolean" }, mode: { type: "string", default: "real" }, "evidence-dir": { type: "string" },
    "opencode-bin": { type: "string" }, plugin: { type: "string", default: "dist/index.js" },
    "backend-url": { type: "string" }, "backend-model": { type: "string", default: "gpt-6-astra" }, "backend-effort": { type: "string", default: "max" },
    "expected-version": { type: "string", default: "1.19.4" }, "real-db": { type: "string" },
    "producer-manifest": { type: "string" }, "driver-manifest": { type: "string" }, "budget-seconds": { type: "string", default: "1800" },
  } })
  if (values.help) {
    console.log(JSON.stringify({ usage: "bun script/qa/autopilot.ts --mode real|fixture --evidence-dir <ignored directory> --producer-manifest <json> --driver-manifest <json> [--opencode-bin <binary>] [--plugin <local bundle>] --backend-url http://127.0.0.1:<port>",
      fixture: "Real OpenCode plus scripted model transport. Exit 2 means actual-model cases and acceptance remain pending.",
      real: "Requires a supplied local Responses backend with /scenario and /stats; verifies unmodified real model A/B/revert output and backend identity.",
      exits: { "0": "driver checks passed; all11 acceptance and independent gates pending", "1": "failed", "2": "incomplete fixture run" } }))
    return
  }
  check(values["evidence-dir"], "evidence_directory_required")
  const repo = await realpath(process.cwd()), directory = path.resolve(values["evidence-dir"])
  check(directory.startsWith(path.join(repo, ".omo", "evidence") + path.sep), "evidence_directory_not_local_ignored_root")
  const mode = values.mode ?? "real", plugin = values.plugin ?? "dist/index.js"
  const evidence = new Evidence(directory, mode)
  let fixture: Fixtures | undefined, provider: Provider | undefined, host: Host | undefined, timer: ReturnType<typeof setTimeout> | undefined
  let before: Data | undefined, failed = false, primary: Data = {}
  try {
    check(["fixture", "real"].includes(mode), "invalid_mode")
    check(values.mode !== "real" || values["backend-url"], "actual_backend_required")
    check(values["producer-manifest"] && values["driver-manifest"], "source_manifests_required")
    const ignored = Bun.spawnSync(["git", "-c", `safe.directory=${repo}`, "check-ignore", "--no-index", directory], { cwd: repo, stdout: "pipe", stderr: "pipe" })
    check(ignored.exitCode === 0, "evidence_directory_not_gitignored")
    const budget = Number(values["budget-seconds"])
    check(Number.isSafeInteger(budget) && budget >= 60 && budget <= 1800, "invalid_budget")
    const sdkVersion = object(JSON.parse(await readFile("node_modules/@opencode-ai/sdk/package.json", "utf8"))).version
    check(sdkVersion === "1.18.31", "sdk_version_mismatch")
    evidence.metadata.source = { producer_manifest: await verifyManifest(values["producer-manifest"], repo), driver_manifest: await verifyManifest(values["driver-manifest"], repo),
      plugin_sha256: digest(await readFile(path.resolve(plugin))), sdk_version: sdkVersion }
    const binary = values["opencode-bin"] ?? Bun.which("opencode.exe") ?? Bun.which("opencode")
    check(binary, "opencode_binary_unavailable")
    before = realSessionCount(values["real-db"])
    fixture = await Fixtures.create(repo); provider = startProvider(values["backend-url"])
    await fixture.hostConfig(path.resolve(plugin), provider.url)
    timer = setTimeout(() => { failed = true; evidence.metadata.fatal_error = "driver_budget_exhausted"; provider?.stop(); void host?.stop() }, budget * 1000)
    host = await Host.start(fixture, provider, binary, values["expected-version"] ?? "1.19.4")
    evidence.metadata.runtime = { version: values["expected-version"], platform: process.platform, arch: process.arch,
      binary, workspace: fixture.workspace, fake_home: fixture.home, HOME_present: Object.hasOwn(fixture.env, "HOME"),
      isolated_xdg: Object.entries(fixture.env).filter(([key]) => key.startsWith("XDG_")).map(([, value]) => value),
      parent_session_id: host.parent, native_agent: host.nativeAgent }
    const context = { fixture, provider, host }, stable = await fixture.contentIdentity()
    await evidence.run("native-task", async () => {
      primary = await context.host.invoke({ id: "initial", arguments: context.fixture.arguments() })
      const result = await context.host.verify(primary)
      check(object(primary.decision).outcome === "approve", "transport_control_failed")
      check(JSON.stringify(stable) === JSON.stringify(await context.fixture.contentIdentity()), "task_store_effect_detected")
      return { ...result, scope: "Actual native server/task/mandatory-hook result; scripted decision is not model judgment" }
    })
    if (mode === "real") await evidence.run("model-policy-ab-revert", () => modelPolicyCases(context, values["backend-model"] ?? "gpt-6-astra", values["backend-effort"] ?? "max"))
    await evidence.run("policy-file-negatives", () => policyNegativeCases(context))
    await evidence.run("native-config", () => nativeConfigCases(context))
    await evidence.run("native-fallback", () => fallbackCase(context))
    await evidence.run("authority-off", () => offCases(context))
    await evidence.run("ordinary-agent", () => ordinaryCase(context))
    await evidence.run("lifecycle-rejections", () => lifecycleCases(context, primary))
    await evidence.run("malformed-result", () => malformedCase(context))
    await evidence.run("tool-boundary", () => toolCases(context))
    await evidence.run("cancellation", () => cancellationCase(context))
    check(JSON.stringify(stable) === JSON.stringify(await fixture.contentIdentity()), "task_store_effect_detected")
  } catch (error) {
    failed = true
    evidence.metadata.fatal_error = error instanceof Error && /^[a-z0-9_:.-]{1,160}$/i.test(error.message) ? error.message : "operation_failed_redacted"
  } finally {
    if (timer) clearTimeout(timer)
    if (provider) evidence.metadata.provider = provider.records
    if (host) evidence.metadata.native_observations = host.observations
    if (failed && host) {
      try { evidence.metadata.child_message_metadata = await host.diagnosticMessages() }
      catch { evidence.metadata.child_message_metadata_unavailable = true }
    }
    try { evidence.metadata.cleanup = host ? await host.stop() : { process_started: false }; provider?.stop()
      if (fixture) { await fixture.cleanup(); object(evidence.metadata.cleanup).temporary_root_removed = true } }
    catch { failed = true; evidence.metadata.cleanup_failure = true; provider?.stop() }
    try {
      if (before) { const after = realSessionCount(String(before.path)); evidence.metadata.real_db = { before, after, unchanged: JSON.stringify(before) === JSON.stringify(after) }
        check(JSON.stringify(before) === JSON.stringify(after), "real_database_session_count_changed") }
      if (values["producer-manifest"] && values["driver-manifest"]) {
        await verifyManifest(values["producer-manifest"], repo); await verifyManifest(values["driver-manifest"], repo); evidence.metadata.source_unchanged = true
      }
    } catch { failed = true; evidence.metadata.readback_failure = true }
    evidence.metadata.failed = failed
    const result = await evidence.save(); console.log(JSON.stringify(result))
    process.exitCode = failed ? 1 : values.mode === "fixture" ? 2 : 0
  }
}
if (import.meta.main) await main()
