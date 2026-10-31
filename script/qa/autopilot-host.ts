import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { Database } from "bun:sqlite"
import { existsSync, watch } from "node:fs"
import { mkdir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { bounded, check, digest, object } from "./autopilot-evidence"
import type { Data } from "./autopilot-evidence"
import type { Fixtures } from "./autopilot-fixtures"
import type { Provider, Scenario } from "./autopilot-provider"

export function realSessionCount(file = path.join(process.env.XDG_DATA_HOME ?? path.join(homedir(), ".local", "share"), "opencode", "opencode.db")): Data {
  if (!existsSync(file)) return { exists: false, count: 0, path: file }
  const db = new Database(file, { readonly: true })
  try { const result = object(db.query("SELECT count(*) AS count FROM session").get()); check(Number.isInteger(result.count), "real_db_count_invalid")
    return { exists: true, count: result.count, path: file } } finally { db.close() }
}
export class Host {
  readonly events: Data[] = []
  readonly observations: Data[] = []
  private readonly listeners = new Set<(event: Data) => void>()
  private readonly streamAbort = new AbortController()
  private streamTask?: Promise<void>
  private streamError = false
  private document: Data = {}
  parent = ""
  parentAgent = ""
  nativeAgent = ""
  ordinaryAgent = ""
  private constructor(readonly fixture: Fixtures, readonly provider: Provider, readonly process: ChildProcess, readonly url: string) {}
  static async start(fixture: Fixtures, provider: Provider, binary: string, version: string): Promise<Host> {
    const child = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: fixture.workspace, env: fixture.env,
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    const ready = Promise.withResolvers<string>()
    let startup = ""
    const onData = (chunk: Buffer) => { startup = (startup + chunk.toString("utf8")).slice(-8192)
      const match = startup.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/); if (match?.[1]) ready.resolve(match[1]) }
    check(child.stdout && child.stderr, "server_pipes_missing")
    child.stdout.on("data", onData); child.stderr.on("data", onData)
    child.once("error", () => ready.reject(new Error("opencode_spawn_failed")))
    child.once("exit", () => ready.reject(new Error("opencode_exited_before_ready")))
    let host: Host | undefined
    try {
      host = new Host(fixture, provider, child, await bounded(ready.promise, 45000, "opencode_start_timeout"))
      const health = object(await host.http("/global/health")); check(health.healthy === true && health.version === version, "opencode_version_or_health_mismatch")
      host.document = object(await host.http("/doc")); check(Object.keys(object(host.document.paths)).length > 0, "openapi_missing")
      await host.subscribe()
      const agents = await host.operation("app.agents", {})
      check(Array.isArray(agents), "agent_discovery_invalid")
      const find = (key: string) => agents.map(object).find(agent => {
        const name = String(agent.name).replace(/[\u200B\u200C\u200D\uFEFF]/g, "").replace(/^\d+\|/, "").toLowerCase()
        return name === key || name.startsWith(key + " (") || name.startsWith(key + " - ")
      })
      const autopilot = find("autopilot"), parent = find("sisyphus"), ordinary = find("explore")
      check(autopilot?.mode === "subagent" && parent && ordinary, "native_agents_missing")
      host.nativeAgent = String(autopilot.name); host.parentAgent = String(parent.name); host.ordinaryAgent = String(ordinary.name)
      const session = object(await host.operation("session.create", {}, { title: "Bounded Autopilot QA" }))
      check(typeof session.id === "string", "parent_session_missing"); host.parent = session.id
      await fixture.task(host.parent)
      await host.providerReady()
      return host
    } catch (error) { if (host) await host.stop(); else child.kill(); throw error }
  }
  private async providerReady(): Promise<void> {
    const cache = this.fixture.env.XDG_CACHE_HOME; check(cache, "isolated_cache_missing")
    const directory = path.join(cache, "oh-my-opencode"), ready = Promise.withResolvers<Data>()
    let unpublishedReads = 0
    await mkdir(directory, { recursive: true })
    const inspect = async () => {
      try {
        const data = object(JSON.parse(await readFile(path.join(directory, "provider-models.json"), "utf8")))
        const models = object(data.models).qa
        if (Array.isArray(data.connected) && data.connected.includes("qa") && Array.isArray(models)
          && models.some(model => model === "judge" || object(model).id === "judge")) ready.resolve({ connected: ["qa"], model_ids: models.map(model => typeof model === "string" ? model : object(model).id) })
      } catch { unpublishedReads += 1 }
    }
    const watcher = watch(directory, () => { void inspect() })
    try { await inspect(); this.observations.push({ provider_catalog: await bounded(ready.promise, 15000, "native_provider_catalog_not_ready"), unpublished_reads: unpublishedReads }) }
    finally { watcher.close() }
  }
  private async http(route: string, init: RequestInit = {}): Promise<unknown> {
    const url = new URL(route, this.url); url.searchParams.set("directory", this.fixture.workspace)
    const response = await fetch(url, { ...init, headers: { "content-type": "application/json", ...init.headers }, signal: AbortSignal.timeout(125000) })
    check(response.ok, `host_http_${response.status}`)
    const text = await response.text(); check(Buffer.byteLength(text) <= 4000000, "host_response_bound")
    return text ? JSON.parse(text) : null
  }
  private resolve(value: unknown): Data {
    const source = object(value)
    if (typeof source.$ref !== "string") return source
    return source.$ref.replace(/^#\//, "").split("/").reduce((current, key) => object(current[key]), this.document)
  }
  async operation(name: string, parameters: Data, body?: Data): Promise<unknown> {
    const normalize = (value: string) => value.replace(/[^a-z]/gi, "").toLowerCase()
    for (const [template, methods] of Object.entries(object(this.document.paths))) for (const [method, raw] of Object.entries(object(methods))) {
      const operation = object(raw)
      if (normalize(String(operation.operationId)) !== normalize(name)) continue
      let route = template
      const query = new URLSearchParams(), payload: Data = { ...body }
      for (const value of Array.isArray(operation.parameters) ? operation.parameters : []) {
        const param = this.resolve(value), key = String(param.name), actual = parameters[key] ?? (key === "id" ? parameters.sessionID : undefined)
        if (actual === undefined) continue
        if (param.in === "path") route = route.replace(`{${key}}`, encodeURIComponent(String(actual)))
        if (param.in === "query") query.set(key, String(actual))
      }
      check(!route.includes("{"), "api_parameter_missing")
      const requestBody = this.resolve(operation.requestBody), media = object(object(requestBody.content)["application/json"])
      const properties = object(this.resolve(media.schema).properties)
      for (const [key, value] of Object.entries(parameters)) if (Object.hasOwn(properties, key)) payload[key] = value
      return this.http(route + (query.size ? `?${query}` : ""), { method: method.toUpperCase(),
        ...(body !== undefined || Object.keys(payload).length ? { body: JSON.stringify(payload) } : {}) })
    }
    throw new Error(`api_operation_missing:${name}`)
  }
  private async subscribe(): Promise<void> {
    const connected = this.wait(event => event.type === "server.connected", 15000)
    const url = new URL("/event", this.url); url.searchParams.set("directory", this.fixture.workspace)
    const response = await fetch(url, { signal: this.streamAbort.signal }); check(response.ok && response.body, "sse_connect_failed")
    const reader = response.body.getReader(), decoder = new TextDecoder()
    this.streamTask = (async () => {
      let buffer = ""
      try {
        while (true) {
          const chunk = await reader.read(); if (chunk.done) break
          buffer += decoder.decode(chunk.value, { stream: true }); check(buffer.length < 4000000, "sse_frame_bound")
          const frames = buffer.split(/\r?\n\r?\n/); buffer = frames.pop() ?? ""
          for (const frame of frames) {
            const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("\n")
            if (!data) continue
            const event = object(JSON.parse(data)); this.events.push(event)
            check(this.events.length < 12000, "sse_event_bound")
            for (const listener of this.listeners) listener(event)
          }
        }
      } catch { if (!this.streamAbort.signal.aborted) this.streamError = true }
      finally { reader.releaseLock() }
    })()
    await connected
  }
  wait(predicate: (event: Data) => boolean, timeout = 125000): Promise<Data> {
    const result = Promise.withResolvers<Data>()
    const listener = (event: Data) => { if (predicate(event)) result.resolve(event) }
    this.listeners.add(listener)
    return bounded(result.promise, timeout, "expected_sse_event_missing").finally(() => this.listeners.delete(listener))
  }
  async invoke(scenario: Scenario, ordinary = false): Promise<Data> {
    check(!this.streamError, "sse_stream_failed")
    await this.provider.select(scenario)
    const callID = `ap2_${scenario.id}`
    const completed = this.wait(event => {
      const part = object(object(event.properties).part), state = object(part.state)
      return part.sessionID === this.parent && part.callID === callID && ["completed", "error"].includes(String(state.status))
    })
    try {
      await this.operation("session.promptAsync", { sessionID: this.parent }, { agent: this.parentAgent,
        model: { providerID: "qa", modelID: "parent-route" }, parts: [{ type: "text", text: `AP2_QA_CALL ${scenario.id}` }] })
    } catch (error) { void completed.catch(() => undefined); throw error }
    const event = await completed, part = object(object(event.properties).part), state = object(part.state)
    if (state.status !== "completed" || typeof state.output !== "string") {
      const error = typeof state.error === "string" ? state.error : JSON.stringify(state.error ?? null)
      this.observations.push({ case_id: scenario.id, parent_session_id: part.sessionID, parent_message_id: part.messageID,
        call_id: callID, status: state.status, error_sha256: digest(error), error_bytes: Buffer.byteLength(error) })
    }
    check(state.status === "completed" && typeof state.output === "string", "native_task_execution_failed")
    let result: Data
    try { result = ordinary ? { ordinary_output: state.output } : object(JSON.parse(state.output)) }
    catch {
      this.observations.push({ case_id: scenario.id, json_valid: false, output_sha256: digest(state.output), output_bytes: Buffer.byteLength(state.output),
        native_continuation_tail: state.output.includes("\nto continue:") })
      throw new Error("public_result_not_json")
    }
    if (!ordinary) {
      check(result.protocol === "autopilot.result.v1" && result.effect === "not_attempted", "public_result_contract_invalid")
      check(!Object.hasOwn(result, "receipt"), "public_result_leaked_receipt")
      this.observations.push({ case_id: scenario.id, protocol: result.protocol, outcome: result.outcome ?? object(result.decision).outcome,
        error: result.error ?? null, invocation_id: result.invocation_id ?? null, request_digest: result.request_digest ?? null,
        provenance: result.provenance ?? null, policy: result.policy ?? null })
    }
    const idle = this.wait(event => event.type === "session.idle" && object(event.properties).sessionID === this.parent, 20000)
    const statuses = object(await this.operation("session.status", {}))
    if (statuses[this.parent] === undefined || object(statuses[this.parent]).type === "idle") { void idle.catch(() => undefined) }
    else await idle
    return { ...result, qa_parent_message_id: part.messageID, qa_call_id: callID }
  }
  async verify(result: Data, model = "judge"): Promise<Data> {
    if (result.outcome === "human_required") throw new Error(`autopilot_rejected:${String(result.error)}`)
    const provenance = object(result.provenance), scope = object(result.scope), host = object(scope.host), decision = object(result.decision)
    check(provenance.agent === "autopilot" && provenance.native_agent === this.nativeAgent && provenance.provider_id === "qa" && provenance.model_id === model, "native_provenance_mismatch")
    check(host.parent_session_id === this.parent && host.tool_call_id === result.qa_call_id && decision.invocation_id === result.invocation_id
      && decision.request_digest === result.request_digest, "native_request_correlation_failed")
    const child = object(await this.operation("session.get", { sessionID: provenance.child_session_id }))
    check(child.parentID === this.parent && child.directory === this.fixture.workspace, "native_child_lineage_mismatch")
    const messages = await this.operation("session.messages", { sessionID: child.id }); check(Array.isArray(messages), "child_messages_invalid")
    const final = messages.map(object).find(message => object(message.info).id === provenance.final_message_id)
    check(final && object(final.info).parentID === provenance.prompt_message_id && object(final.info).role === "assistant", "native_final_identity_mismatch")
    const finalText = (Array.isArray(final.parts) ? final.parts.map(object) : []).filter(part => part.type === "text" && !part.ignored && !part.synthetic)
      .map(part => typeof part.text === "string" ? part.text : "").join("\n")
    check(finalText.length > 0, "native_final_text_missing")
    check(this.events.some(event => { const p = object(object(event.properties).part); return p.sessionID === child.id && p.messageID === provenance.final_message_id }), "child_sse_evidence_missing")
    return { parent_session_id: this.parent, parent_message_id: result.qa_parent_message_id, tool_call_id: result.qa_call_id,
      invocation_id: result.invocation_id, request_digest: result.request_digest, provenance, policy: result.policy, outcome: decision.outcome,
      final_text_sha256: digest(finalText),
      subject_digest: object(scope.subject).digest, evidence: (Array.isArray(scope.evidence) ? scope.evidence : []).map(item => ({ id: object(item).id, sha256: object(item).sha256 })) }
  }
  async stop(): Promise<Data> {
    this.streamAbort.abort()
    if (this.streamTask) await bounded(this.streamTask, 5000, "sse_shutdown_timeout")
    if (this.process.exitCode === null && this.process.signalCode === null) {
      const exited = new Promise<void>(resolve => this.process.once("exit", () => resolve()))
      if (process.platform === "win32") {
        const killer = spawn("taskkill", ["/PID", String(this.process.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" })
        await bounded(new Promise<void>((resolve, reject) => { killer.once("error", reject); killer.once("exit", () => resolve()) }), 5000, "process_tree_stop_timeout")
      } else this.process.kill("SIGTERM")
      await bounded(exited, 10000, "opencode_cleanup_timeout")
    }
    return { process_exited: this.process.exitCode !== null || this.process.signalCode !== null, sse_closed: true,
      event_counts: Object.fromEntries([...new Set(this.events.map(event => String(event.type)))].map(type => [type, this.events.filter(event => event.type === type).length])) }
  }
  async diagnosticMessages(): Promise<Data[]> {
    const children = await this.operation("session.children", { sessionID: this.parent })
    check(Array.isArray(children), "diagnostic_children_invalid")
    const result: Data[] = []
    for (const child of children.map(object).slice(0, 64)) {
      const messages = await this.operation("session.messages", { sessionID: child.id })
      check(Array.isArray(messages), "diagnostic_messages_invalid")
      result.push({ child_session_id: child.id, parent_session_id: child.parentID, messages: messages.map(message => {
        const info = object(object(message).info)
        return Object.fromEntries(["id", "parentID", "role", "agent", "providerID", "modelID", "finish", "time"].map(key => [key, info[key] ?? null]))
      }) })
    }
    return result
  }
}
export interface Context { fixture: Fixtures; provider: Provider; host: Host }
