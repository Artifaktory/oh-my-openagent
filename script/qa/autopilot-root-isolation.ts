import { readFile } from "node:fs/promises"
import path from "node:path"
import { check, object } from "./autopilot-evidence"
import type { Data } from "./autopilot-evidence"
import type { Fixtures } from "./autopilot-fixtures"
import type { Host } from "./autopilot-host"

interface FixtureEntry {
  fixture: Fixtures
  receipt: Data
  hosts: { host: Host; receipt: Data; stopped: boolean }[]
  finished: boolean
}

export class RootIsolation {
  readonly records: Data[] = []
  readonly observations: Data[] = []
  private readonly entries = new Map<Fixtures, FixtureEntry>()

  add(fixture: Fixtures): void {
    check(![...this.entries.keys()].some(prior => prior.root === fixture.root || prior.workspace === fixture.workspace), "fixture_root_reused")
    const receipt: Data = { fixture_id: this.records.length + 1, workspace: fixture.workspace, temporary_root: fixture.root,
      fake_home: fixture.home, HOME_present: Object.hasOwn(fixture.env, "HOME"),
      isolated_xdg: Object.entries(fixture.env).filter(([key]) => key.startsWith("XDG_")).map(([, value]) => value),
      before: null, after: null, no_effect: null, setup_complete: false, hosts: [], startup_cleanup: [] }
    this.records.push(receipt)
    this.entries.set(fixture, { fixture, receipt, hosts: [], finished: false })
  }
  private entry(fixture: Fixtures): FixtureEntry {
    const entry = this.entries.get(fixture); check(entry, "fixture_not_registered"); return entry
  }
  startupCleanup(fixture: Fixtures, cleanup: Data): void {
    const entry = this.entry(fixture)
    ;(entry.receipt.startup_cleanup as Data[]).push(cleanup)
    if (Array.isArray(cleanup.native_observations)) this.observations.push(...cleanup.native_observations.map(object))
    if (cleanup.process_exited !== true || cleanup.sse_closed !== true || cleanup.cleanup_failed === true) entry.receipt.cleanup_failed = true
  }
  attach(fixture: Fixtures, host: Host): void {
    const entry = this.entry(fixture)
    check(host.fixture === fixture && !entry.finished, "fixture_host_mismatch")
    check(entry.receipt.parent_session_id === undefined || entry.receipt.parent_session_id === host.parent, "fixture_parent_changed")
    entry.receipt.parent_session_id = host.parent
    const receipt: Data = { pid: host.process.pid, parent_session_id: host.parent, native_agent: host.nativeAgent }
    entry.hosts.push({ host, receipt, stopped: false })
    ;(entry.receipt.hosts as Data[]).push(receipt)
  }
  async baseline(fixture: Fixtures): Promise<Data> {
    const entry = this.entry(fixture)
    check(entry.receipt.before === null, "fixture_baseline_already_captured")
    const task = object(JSON.parse(await readFile(path.join(fixture.workspace, "tasks", "task1.json"), "utf8")))
    check(task.threadID === entry.receipt.parent_session_id, "fixture_task_parent_mismatch")
    const before = await fixture.contentIdentity()
    Object.assign(entry.receipt, { before, setup_complete: true })
    return before
  }
  async verify(fixture: Fixtures): Promise<void> {
    const entry = this.entry(fixture)
    if (entry.receipt.before === null) return
    try { entry.receipt.after = await fixture.contentIdentity() }
    catch { entry.receipt.no_effect = false; throw new Error("task_store_effect_detected") }
    entry.receipt.no_effect = JSON.stringify(entry.receipt.before) === JSON.stringify(entry.receipt.after)
    check(entry.receipt.no_effect, "task_store_effect_detected")
  }
  async stop(host: Host): Promise<Data> {
    const entry = this.entry(host.fixture), tracked = entry.hosts.find(item => item.host === host)
    check(tracked, "fixture_host_not_registered")
    if (tracked.stopped) {
      check(tracked.receipt.cleanup_failed !== true, "fixture_host_cleanup_failed")
      return object(tracked.receipt.cleanup)
    }
    tracked.stopped = true
    this.observations.push(...structuredClone(host.observations))
    try {
      const cleanup = await host.stop(); tracked.receipt.cleanup = cleanup
      check(cleanup.process_exited === true && cleanup.sse_closed === true, "prior_native_process_not_stopped")
      return cleanup
    } catch (error) { tracked.receipt.cleanup_failed = true; entry.receipt.cleanup_failed = true; throw error }
  }
  async finish(fixture: Fixtures): Promise<void> {
    const entry = this.entry(fixture)
    if (entry.finished) {
      check(entry.receipt.no_effect !== false && entry.receipt.cleanup_failed !== true, "fixture_finalization_failed")
      return
    }
    let failure: unknown
    try { await this.verify(fixture) } catch (error) { failure = error }
    for (const tracked of entry.hosts) {
      try { await this.stop(tracked.host) } catch (error) { failure ??= error }
    }
    try { await fixture.cleanup(); entry.receipt.cleanup = { temporary_root_removed: true } }
    catch (error) { entry.receipt.cleanup_failed = true; entry.receipt.cleanup = { temporary_root_removed: false }; failure ??= error }
    entry.finished = true
    if (failure) throw failure
    check(entry.receipt.cleanup_failed !== true, "fixture_startup_cleanup_failed")
  }
  async finishAll(): Promise<Data> {
    let failure: unknown
    for (const fixture of this.entries.keys()) {
      try { await this.finish(fixture) } catch (error) { failure ??= error }
    }
    if (failure) throw failure
    return { temporary_root_removed: true, process_exited: true, sse_closed: true, fixtures: this.records.length }
  }
}
