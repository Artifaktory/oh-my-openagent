import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { Database } from "bun:sqlite"
import { existsSync, watch } from "node:fs"
import { mkdir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { bounded, check, digest, object, ordinaryInput, ordinaryText } from "./autopilot-evidence"
import type { Data } from "./autopilot-evidence"
import type { Fixtures } from "./autopilot-fixtures"
import type { Provider, Scenario } from "./autopilot-provider"
import { explicitDenialCode, maskedDenialReference, NativeDenialObserver } from "./autopilot-native-denial"
import { DEFAULT_PROMPT_ASYNC_POST_DISPATCH_HOLD_MS } from "../../packages/utils/src/prompt-async-gate/timing"

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
  private readonly nativeDenials: NativeDenialObserver
  private constructor(readonly fixture: Fixtures, readonly provider: Provider, readonly process: ChildProcess, readonly url: string) {
    this.nativeDenials = new NativeDenialObserver(process)
  }
  static async start(fixture: Fixtures, provider: Provider, binary: string, version: string, retainedParent?: string,
    startupCleanup?: (receipt: Data) => void): Promise<Host> {
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
      const agents = await host.operation("app.agents", {})
      check(Array.isArray(agents), "agent_discovery_invalid")
      const find = (key: string) => agents.map(object).find(agent => {
        const name = String(agent.name).replace(/[\u200B\u200C\u200D\uFEFF]/g, "").replace(/^\d+\|/, "").toLowerCase()
        return name === key || name.startsWith(key + " (") || name.startsWith(key + " - ")
      })
      const configuredName = object(object(object(fixture.user["[opencode]"]).agents).autopilot).displayName
      const autopilot = typeof configuredName === "string" ? find(configuredName.toLowerCase()) : find("autopilot")
      const parent = find("sisyphus"), ordinary = find("explore")
      check(autopilot?.mode === "subagent" && parent && ordinary, "native_agents_missing")
      host.nativeAgent = String(autopilot.name); host.parentAgent = String(parent.name); host.ordinaryAgent = String(ordinary.name)
      await host.subscribe()
      const session = object(retainedParent ? await host.operation("session.get", { sessionID: retainedParent })
        : await host.operation("session.create", {}, { title: "Bounded Autopilot QA" }))
      check(typeof session.id === "string", "parent_session_missing"); host.parent = session.id
      if (retainedParent) check(session.id === retainedParent && session.directory === fixture.workspace, "restarted_parent_identity_mismatch")
      else await fixture.task(host.parent)
      await host.providerReady()
      return host
    } catch (error) {
      let cleanup: Data = { process_started: child.pid !== undefined, process_exited: false, sse_closed: !host,
        native_observations: structuredClone(host?.observations ?? []) }
      try {
        if (host) cleanup = { ...cleanup, ...await host.stop() }
        else {
          if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
            const exited = new Promise<void>(resolve => child.once("exit", () => resolve()))
            child.kill(); await bounded(exited, 10000, "opencode_cleanup_timeout")
          }
          cleanup.process_exited = child.pid === undefined || child.exitCode !== null || child.signalCode !== null
        }
      } catch { cleanup.cleanup_failed = true }
      startupCleanup?.(cleanup)
      throw error
    }
  }
  private async providerReady(): Promise<void> {
    const cache = this.fixture.env.XDG_CACHE_HOME; check(cache, "isolated_cache_missing")
    const directory = path.join(cache, "oh-my-opencode"), ready = Promise.withResolvers<Data>()
    let unpublishedReads = 0
    await mkdir(directory, { recursive: true })
    const inspect = async () => {
      try {
        const data = object(JSON.parse(await readFile(path.join(directory, "provider-models.json"), "utf8")))
        const models = object(data.models).qa, builtin = object(data.models).openai
        if (Array.isArray(data.connected) && data.connected.includes("qa") && data.connected.includes("openai") && Array.isArray(models)
          && models.some(model => model === "judge" || object(model).id === "judge") && Array.isArray(builtin)
          && builtin.some(model => model === "gpt-6-astra" || object(model).id === "gpt-6-astra")) ready.resolve({ connected: ["qa", "openai"],
            model_ids: models.map(model => typeof model === "string" ? model : object(model).id), builtin_candidate: "openai/gpt-6-astra", transport: "loopback-controlled" })
      } catch { unpublishedReads += 1 }
    }
    const watcher = watch(directory, () => { void inspect() })
    try { await inspect(); this.observations.push({ provider_catalog: await bounded(ready.promise, 15000, "native_provider_catalog_not_ready"), unpublished_reads: unpublishedReads }) }
    finally { watcher.close() }
  }
  private async http(route: string, init: RequestInit = {}, denialChild?: string): Promise<unknown> {
    const url = new URL(route, this.url); url.searchParams.set("directory", this.fixture.workspace)
    const signal = AbortSignal.any([AbortSignal.timeout(125000), ...(init.signal ? [init.signal] : []),
      ...(denialChild ? [this.streamAbort.signal] : [])])
    const capture = denialChild ? this.nativeDenials.begin(denialChild, signal) : undefined
    const interrupted = Promise.withResolvers<never>()
    const abort = () => interrupted.reject(new Error("host_request_cancelled"))
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
    try {
      const response = await Promise.race([fetch(url, { ...init, headers: { "content-type": "application/json", ...init.headers }, signal }), interrupted.promise])
      const text = await Promise.race([response.text(), interrupted.promise]); check(Buffer.byteLength(text) <= 4000000, "host_response_bound")
      check(!signal.aborted, "host_request_cancelled")
      if (!response.ok) {
        let error: unknown
        try { error = JSON.parse(text) } catch { error = undefined }
        let reason = explicitDenialCode(error)
        const ref = response.status === 500 ? maskedDenialReference(error) : undefined
        if (!reason && ref && capture) {
          reason = await Promise.race([capture.wait(ref), interrupted.promise])
          const metadata = capture.metadata()
          if (!metadata.valid) reason = undefined
          this.observations.push({ kind: "native_direct_denial", ...metadata, http_status: response.status, ref,
            guard_code: reason ?? null, qualified: reason !== undefined })
        }
        check(!signal.aborted, "host_request_cancelled")
        throw new Error(reason ? `host_denied:${reason}` : `host_http_${response.status}`)
      }
      return text ? JSON.parse(text) : null
    } finally { signal.removeEventListener("abort", abort); capture?.finish() }
  }
  private resolve(value: unknown): Data {
    const source = object(value)
    if (typeof source.$ref !== "string") return source
    return source.$ref.replace(/^#\//, "").split("/").reduce((current, key) => object(current[key]), this.document)
  }
  async operation(name: string, parameters: Data, body?: Data, signal?: AbortSignal): Promise<unknown> {
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
      return this.http(route + (query.size ? `?${query}` : ""), { method: method.toUpperCase(), signal,
        ...(body !== undefined || Object.keys(payload).length ? { body: JSON.stringify(payload) } : {}) },
      normalize(name) === "sessionprompt" && typeof parameters.sessionID === "string" && parameters.sessionID.length > 0 ? parameters.sessionID : undefined)
    }
    throw new Error(`api_operation_missing:${name}`)
  }
  private async subscribe(): Promise<void> {
    const connected = this.wait(event => event.type === "server.connected", 15000, this.streamAbort.signal)
    const url = new URL("/event", this.url); url.searchParams.set("directory", this.fixture.workspace)
    const opening = (async () => {
      const response = await fetch(url, { signal: this.streamAbort.signal })
      if (this.streamAbort.signal.aborted || !response.ok) {
        void response.body?.cancel().catch(() => undefined)
        check(!this.streamAbort.signal.aborted, "sse_connect_cancelled")
      }
      check(response.ok && response.body, "sse_connect_failed")
      const reader = response.body.getReader(), decoder = new TextDecoder()
      const cancel = () => { void reader.cancel().catch(() => undefined) }
      this.streamAbort.signal.addEventListener("abort", cancel, { once: true })
      this.streamTask = (async () => {
        let buffer = ""
        try {
          while (true) {
            const chunk = await reader.read(); if (chunk.done || this.streamAbort.signal.aborted) break
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
        finally { this.streamAbort.signal.removeEventListener("abort", cancel); cancel(); reader.releaseLock() }
      })()
      await Promise.race([connected, this.streamTask.then(() => { throw new Error("sse_stream_failed") })])
    })()
    try { await Promise.all([connected, opening]) }
    catch (error) { this.streamAbort.abort(); await connected.catch(() => undefined); throw error }
  }
  wait(predicate: (event: Data) => boolean, timeout = 125000, signal?: AbortSignal): Promise<Data> {
    const result = Promise.withResolvers<Data>()
    const listener = (event: Data) => { if (predicate(event)) result.resolve(event) }
    const abort = () => result.reject(new Error("sse_connect_cancelled"))
    this.listeners.add(listener)
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) abort()
    return bounded(result.promise, timeout, "expected_sse_event_missing").finally(() => {
      this.listeners.delete(listener)
      signal?.removeEventListener("abort", abort)
    })
  }
  private async ordinaryReady(readiness: { childID: string; resultAt: number; eventStart: number }): Promise<() => void> {
    const { childID, resultAt, eventStart } = readiness
    check(childID.length > 0 && Number.isFinite(resultAt) && Number.isInteger(eventStart)
      && eventStart >= 0 && eventStart <= this.events.length, "ordinary_readiness_anchor_invalid")
    // The successful tool result is later than the original gate's finally/hold anchor.
    const holdUntil = resultAt + DEFAULT_PROMPT_ASYNC_POST_DISPATCH_HOLD_MS, deadline = resultAt + 20000
    const phase = new AbortController(), interrupted = Promise.withResolvers<never>()
    let failure: Error | undefined, active = true, holdTimer: ReturnType<typeof setTimeout> | undefined
    const fail = (code: string) => {
      if (!active || failure) return
      failure = new Error(code); Object.assign(observation, { status: "failed", error: code }); interrupted.reject(failure); phase.abort()
    }
    const ensure = () => {
      if (this.streamAbort.signal.aborted) fail("ordinary_readiness_cancelled")
      if (this.streamError) fail("ordinary_readiness_stream_failed")
      if (Date.now() >= deadline) fail("ordinary_readiness_timeout")
      if (failure) throw failure
    }
    const listener = (event: Data) => {
      const properties = object(event.properties), info = object(properties.info), part = object(properties.part)
      const sessionID = properties.sessionID ?? info.sessionID ?? part.sessionID
      const deletedID = info.id ?? properties.sessionID
      if (event.type === "session.deleted" && [childID, this.parent].includes(String(deletedID))) fail("ordinary_readiness_deleted")
      if (event.type === "session.error" && [childID, this.parent].includes(String(sessionID))) fail("ordinary_readiness_error")
      if (sessionID !== childID) return
      if (event.type === "session.status" && object(properties.status).type !== "idle") fail("ordinary_readiness_activity")
      if (["message.updated", "message.part.updated", "message.part.delta"].includes(String(event.type))) fail("ordinary_readiness_activity")
    }
    const abort = () => fail("ordinary_readiness_cancelled")
    const observation: Data = { kind: "ordinary_continuation_readiness", child_session_id: childID, parent_session_id: this.parent,
      first_tool_result_at: resultAt, event_start: eventStart, hold_ms: DEFAULT_PROMPT_ASYNC_POST_DISPATCH_HOLD_MS,
      hold_until: holdUntil, phase_deadline: deadline, status: "waiting" }
    this.observations.push(observation)
    this.listeners.add(listener)
    this.streamAbort.signal.addEventListener("abort", abort, { once: true })
    const timeout = setTimeout(() => fail("ordinary_readiness_timeout"), Math.max(0, deadline - Date.now()))
    void this.streamTask?.then(() => fail("ordinary_readiness_stream_failed"), () => fail("ordinary_readiness_stream_failed"))
    const cleanup = () => {
      active = false; clearTimeout(timeout); clearTimeout(holdTimer)
      this.listeners.delete(listener); this.streamAbort.signal.removeEventListener("abort", abort); phase.abort()
    }
    try {
      const ready = (async () => {
        for (const event of this.events.slice(eventStart)) listener(event)
        ensure()
        await Promise.race([new Promise<void>(resolve => {
          holdTimer = setTimeout(resolve, Math.max(0, holdUntil - Date.now()))
        }), interrupted.promise])
        ensure()
        check(Date.now() >= holdUntil, "ordinary_readiness_hold_incomplete")
        const child = object(await Promise.race([
          this.operation("session.get", { sessionID: childID }, undefined, phase.signal), interrupted.promise,
        ]))
        ensure()
        check(child.id === childID && child.parentID === this.parent && child.directory === this.fixture.workspace,
          "ordinary_readiness_child_mismatch")
        const raw = await Promise.race([this.operation("session.status", {}, undefined, phase.signal), interrupted.promise])
        ensure()
        check(raw !== null && typeof raw === "object" && !Array.isArray(raw), "ordinary_readiness_status_invalid")
        const status = object(raw)[childID]
        // Native status.list removes idle entries; existence/lineage was proved separately above.
        check(status === undefined || object(status).type === "idle", "ordinary_readiness_child_active")
        Object.assign(observation, { status: "ready", ready_at: Date.now(), child_status: status === undefined ? "idle-omitted" : "idle" })
      })()
      await Promise.race([ready, interrupted.promise])
      ensure()
      // Retain guards across the await back to invoke, then commit synchronously before its trigger.
      return () => { try { ensure() } finally { cleanup() } }
    } catch (error) {
      Object.assign(observation, { status: "failed", error: error instanceof Error ? error.message : "ordinary_readiness_failed" })
      cleanup(); throw error
    }
  }
  async invoke(scenario: Scenario, ordinary = false, readiness?: { childID: string; resultAt: number; eventStart: number }): Promise<Data> {
    check(!this.streamError, "sse_stream_failed")
    await this.provider.select(scenario)
    const commitReadiness = readiness ? await this.ordinaryReady(readiness) : undefined
    commitReadiness?.()
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
    if (ordinary && scenario.ordinary && ["ordinary", "ordinary-continue"].includes(scenario.id)
      && scenario.arguments.prompt === "Return ORDINARY_AGENT_OK." && scenario.arguments.subagent_type === this.ordinaryAgent) {
      this.observations.push({ kind: "ordinary_tool_state", case_id: scenario.id, parent_session_id: part.sessionID,
        parent_message_id: part.messageID, part_id: part.id, call_id: part.callID, tool: part.tool, status: state.status,
        selected_input: ordinaryInput(scenario.arguments, this.ordinaryAgent), wire_input: ordinaryInput(state.input, this.ordinaryAgent),
        output: ordinaryText(state.output), error: ordinaryText(typeof state.error === "string" ? state.error : object(state.error).message),
        error_code: ordinaryText(object(state.error).code) })
    }
    if (state.status !== "completed" || typeof state.output !== "string") {
      const error = typeof state.error === "string" ? state.error : JSON.stringify(state.error ?? null)
      this.observations.push({ case_id: scenario.id, parent_session_id: part.sessionID, parent_message_id: part.messageID,
        call_id: callID, status: state.status, error_sha256: digest(error), error_bytes: Buffer.byteLength(error) })
    }
    check(state.status === "completed" && typeof state.output === "string", "native_task_execution_failed")
    const toolResultAt = Date.now(), toolResultEventStart = this.events.indexOf(event) + 1
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
    return { ...result, qa_parent_message_id: part.messageID, qa_call_id: callID,
      ...(ordinary ? { qa_tool_result_at: toolResultAt, qa_tool_result_event_start: toolResultEventStart } : {}) }
  }
  async verify(result: Data, model = "judge", provider = "qa"): Promise<Data> {
    if (result.outcome === "human_required") throw new Error(`autopilot_rejected:${String(result.error)}`)
    const provenance = object(result.provenance), scope = object(result.scope), host = object(scope.host), decision = object(result.decision)
    check(provenance.agent === "autopilot" && provenance.native_agent === this.nativeAgent && provenance.provider_id === provider && provenance.model_id === model, "native_provenance_mismatch")
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
    this.nativeDenials.dispose()
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
