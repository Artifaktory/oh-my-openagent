import assert from "node:assert/strict"
import { fileURLToPath, pathToFileURL } from "node:url"
import path from "node:path"
import type { Host } from "./autopilot-host"

const cases = ["timely", "wrong-event", "late-headers", "never-headers", "fetch-error", "bad-response",
  "stream-error", "stream-end", "cancel-pending", "late-rejection"] as const
type Case = typeof cases[number]
const unitDeadline = 200
const turn = () => new Promise<void>(resolve => setImmediate(resolve))
const message = (error: unknown) => error instanceof Error ? error.message : String(error)

async function observe<T>(promise: Promise<T>): Promise<T | "observation_deadline"> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<"observation_deadline">(resolve => {
      timer = setTimeout(() => resolve("observation_deadline"), 1200)
    })])
  } finally { clearTimeout(timer) }
}

async function probe(scenario: Case, target: string) {
  const module = await import(pathToFileURL(target).href) as { Host: typeof Host }
  // The frozen class has the same constructor and methods. No native process is started.
  const host = Reflect.construct(module.Host, [{ workspace: "synthetic-qa-workspace" }, {},
    { exitCode: 0, signalCode: null }, "http://127.0.0.1:1"]) as Host
  const originalWait = host.wait.bind(host), requestedDeadlines: number[] = []
  host.wait = (predicate, timeout, ...rest: unknown[]) => {
    requestedDeadlines.push(timeout ?? 125000)
    return Reflect.apply(originalWait, host, [predicate, unitDeadline, ...rest])
  }
  const nativeFetch = globalThis.fetch, response = Promise.withResolvers<Response>()
  const unhandled: string[] = []
  const onUnhandled = (error: unknown) => { unhandled.push(message(error)) }
  process.on("unhandledRejection", onUnhandled)
  let signal: AbortSignal | undefined, fetchCalls = 0, cancels = 0
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({
    start(value) { controller = value },
    cancel() { cancels += 1 },
  }, { highWaterMark: 0 })
  const send = (text: string) => controller.enqueue(new TextEncoder().encode(text))
  const event = (type: string) => send(`data: ${JSON.stringify({ type, properties: {} })}\n\n`)
  globalThis.fetch = Object.assign((_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    fetchCalls += 1
    signal = init?.signal ?? undefined
    assert(signal, "fixture must receive the Host's actual abort signal")
    assert.equal(requestedDeadlines.length, 1, "waiter must start before fetch")
    // Intentionally ignores abort: the Host must not wait forever or adopt a late body.
    return response.promise
  }, { preconnect: nativeFetch.preconnect })
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined
  const deadlineBoundary = new Promise<void>(resolve => {
    deadlineTimer = setTimeout(resolve, unitDeadline + 50)
  })
  let result: { status: string; error?: string } = { status: "pending" }
  let completed: Promise<void> | undefined
  let stop: Awaited<ReturnType<Host["stop"]>> | "observation_deadline" | undefined
  try {
    // given a real Host waiter/parser and a controllable transport, when startup begins
    completed = host["subscribe"]().then(() => { result = { status: "resolved" } }, error => {
      result = { status: "rejected", error: message(error) }
    })
    if (scenario === "fetch-error") response.reject(new Error("fixture_fetch_failed"))
    else if (scenario === "bad-response") response.resolve(new Response(body, { status: 503 }))
    else if (["timely", "wrong-event", "stream-error", "stream-end"].includes(scenario)) {
      response.resolve(new Response(body, { headers: { "content-type": "text/event-stream" } }))
      await turn()
      if (scenario === "stream-error") controller.error(new Error("fixture_read_failed"))
      else if (scenario === "stream-end") controller.close()
      else {
        event("session.created")
        await turn()
        assert.equal(result.status, "pending", "a different native event cannot satisfy startup")
        if (scenario === "timely") {
          send('data: {"type":"server.con')
          send('nected","properties":{}}\n\n')
        }
      }
    }
    if (scenario === "cancel-pending") stop = await host.stop()
    const observation = await observe(completed)
    const atOutcome = { ...result, aborted: signal?.aborted, listeners: host["listeners"].size }
    if (scenario === "late-headers") {
      event("server.connected")
      response.resolve(new Response(body))
      await turn()
    } else if (scenario === "late-rejection") {
      response.reject(new Error("fixture_late_fetch_failed"))
      await turn()
    }
    // Time is the subject here: cross the real unit deadline to expose detached rejection.
    await deadlineBoundary
    await turn()
    const afterLate = { events: host.events.map(value => value.type), cancels, locked: body.locked }
    stop ??= await observe(host.stop())
    await turn()
    return { scenario, target, fetchCalls, requestedDeadlines, observation, atOutcome, afterLate,
      unhandled: [...unhandled], stop, lockedAfterStop: body.locked }
  } finally {
    // Finish old-code pending fetches only after recording the failing observations.
    try {
      response.resolve(new Response(null, { status: 503 }))
      await Promise.resolve().then(() => controller.close()).catch(() => undefined)
      await observe(completed ?? Promise.resolve())
      await host.stop()
      if (!body.locked) await body.cancel().catch(() => undefined)
    } finally {
      clearTimeout(deadlineTimer)
      globalThis.fetch = nativeFetch
      process.off("unhandledRejection", onUnhandled)
    }
  }
}

const readinessCases = ["fresh", "retained", "discovery-failure", "invalid-discovery", "missing-agent", "wrong-mode"] as const
type ReadinessCase = typeof readinessCases[number]

async function readinessProbe(scenario: ReadinessCase, target: string) {
  const { mock } = await import("bun:test")
  const childProcess = await import("node:child_process")
  const { EventEmitter } = await import("node:events")
  const { PassThrough } = await import("node:stream")
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), exitCode: 0, signalCode: null,
  })
  let spawns = 0
  mock.module("node:child_process", () => ({ ...childProcess, spawn: () => {
    spawns += 1
    queueMicrotask(() => child.stdout.emit("data", Buffer.from("listening on http://127.0.0.1:1")))
    return child
  } }))
  const nativeFetch = globalThis.fetch
  const module = await import(pathToFileURL(target).href) as { Host: typeof Host }
  const originalWait = module.Host.prototype.wait, originalProviderReady = module.Host.prototype["providerReady"]
  const workspace = "synthetic-readiness-workspace", parentID = "synthetic-parent"
  const trace: string[] = [], directories: { route: string; directory: string | null }[] = []
  const first = Promise.withResolvers<string>(), discovered = Promise.withResolvers<void>()
  const discovery = Promise.withResolvers<Response>(), mandatorySeen = Promise.withResolvers<void>()
  const names = { native: "7|Readiness Judge", parent: "2|Sisyphus (Fixture)", ordinary: "3|Explore - Fixture" }
  let captured: Host | undefined, returned: Host | undefined, eventRequests = 0, parentRequests = 0, tasks = 0, providerChecks = 0
  let namesAtSubscribe: unknown, requestedDeadline: number | undefined, cancels = 0
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({ start(value) { controller = value }, cancel() { cancels += 1 } })
  const send = (types: string[]) => controller.enqueue(new TextEncoder().encode(types.map(type =>
    `data: ${JSON.stringify({ type, properties: { sessionID: parentID } })}\n\n`).join("")))
  const actions: { name: string; connected: boolean }[] = []
  const action = (name: string) => {
    trace.push(name)
    actions.push({ name, connected: captured?.events.some(event => event.type === "server.connected") ?? false })
  }
  module.Host.prototype.wait = function (predicate, timeout, signal) {
    captured = this
    requestedDeadline = timeout
    namesAtSubscribe = { native: this.nativeAgent, parent: this.parentAgent, ordinary: this.ordinaryAgent }
    this["listeners"].add(event => { if (event.type === "session.deleted") mandatorySeen.resolve() })
    return originalWait.call(this, predicate, timeout, signal)
  }
  module.Host.prototype["providerReady"] = async function () { providerChecks += 1; action("provider-ready") }
  const fixture = { workspace, env: {}, user: { "[opencode]": { agents: { autopilot: { displayName: "Readiness Judge" } } } },
    async task(id: string) { assert.equal(id, parentID); tasks += 1; action("task") } }
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input)), route = url.pathname
    directories.push({ route, directory: url.searchParams.get("directory") })
    if (route === "/global/health") return Response.json({ healthy: true, version: "fixture" })
    if (route === "/doc") return Response.json({ paths: {
      "/agent": { get: { operationId: "app.agents" } },
      "/session": { post: { operationId: "session.create" } },
      "/session/{id}": { get: { operationId: "session.get", parameters: [{ name: "id", in: "path" }] } },
    } })
    if (route === "/agent") { trace.push("discovery-entered"); first.resolve("discovery"); discovered.resolve(); return discovery.promise }
    if (route === "/event") {
      eventRequests += 1; trace.push("event"); first.resolve("event")
      assert(init?.signal, "SSE must carry the actual abort signal")
      // One chunk exercises events immediately following the connection frame.
      send(["server.connected", "session.created", "message.part.updated", "session.deleted"])
      return new Response(body, { headers: { "content-type": "text/event-stream" } })
    }
    if (route === "/session" || route === `/session/${parentID}`) {
      parentRequests += 1; action(route === "/session" ? "parent-create" : "parent-get")
      assert.equal(init?.method, route === "/session" ? "POST" : "GET")
      return Response.json({ id: parentID, directory: workspace })
    }
    throw new Error(`unexpected_fixture_route:${route}`)
  }, { preconnect: nativeFetch.preconnect })
  let outcome: { status: string; error?: string } = { status: "pending" }
  let pending: Promise<void> | undefined
  try {
    // given a latched discovery response, when the actual owner starts
    const starting = Reflect.apply(module.Host.start, module.Host,
      [fixture, {}, "synthetic-no-native-binary", "fixture", scenario === "retained" ? parentID : undefined]) as Promise<Host>
    pending = starting.then(host => { returned = host; outcome = { status: "resolved" } }, error => {
      outcome = { status: "rejected", error: message(error) }
    })
    const firstBoundary = await observe(first.promise)
    assert.notEqual(await observe(discovered.promise), "observation_deadline", "Host must reach discovery")
    const whileDiscoveryHeld = { eventRequests, parentRequests, tasks, providerChecks }
    trace.push("discovery-released")
    if (scenario === "discovery-failure") discovery.reject(new Error("fixture_discovery_failed"))
    else {
      const agents = [{ name: names.native, mode: scenario === "wrong-mode" ? "primary" : "subagent" },
        { name: names.parent, mode: "primary" }, { name: names.ordinary, mode: "subagent" }]
      discovery.resolve(Response.json(scenario === "invalid-discovery" ? {} : scenario === "missing-agent" ? agents.slice(1) : agents))
    }
    assert.notEqual(await observe(pending), "observation_deadline", "Host.start must settle after discovery")
    if (returned) assert.notEqual(await observe(mandatorySeen.promise), "observation_deadline", "immediate mandatory events must be parsed")
    const events = captured?.events.map(event => event.type) ?? []
    await captured?.stop()
    return { target, scenario, spawns, firstBoundary, whileDiscoveryHeld, trace, directories, outcome,
      eventRequests, parentRequests, tasks, providerChecks, namesAtSubscribe, requestedDeadline, actions, events,
      parent: returned?.parent, names: returned && { native: returned.nativeAgent, parent: returned.parentAgent, ordinary: returned.ordinaryAgent },
      cancels, lockedAfterStop: body.locked }
  } finally {
    discovery.resolve(Response.json([]))
    await observe(pending ?? Promise.resolve())
    try { await captured?.stop(); if (!body.locked) await body.cancel().catch(() => undefined) }
    finally {
      module.Host.prototype.wait = originalWait
      module.Host.prototype["providerReady"] = originalProviderReady
      globalThis.fetch = nativeFetch
      mock.restore()
      child.stdout.destroy(); child.stderr.destroy()
    }
  }
}


const ordinaryHoldCases = ["ordinary", "custom", "explicit-idle", "wrong-child", "wrong-parent", "wrong-directory",
  "missing-child", "active", "retry", "invalid-status", "deleted", "error", "activity", "late-activity", "budget", "cancel"] as const
type OrdinaryHoldCase = typeof ordinaryHoldCases[number]

async function ordinaryHoldProbe(scenario: OrdinaryHoldCase, target: string) {
  const { spyOn } = await import("bun:test")
  const gate = await import("../../packages/utils/src/prompt-async-gate")
  const { Host: TargetHost } = await import(pathToFileURL(target).href) as { Host: typeof Host }
  const configTarget = path.join(path.dirname(target), "autopilot-config-cases.ts")
  const { ordinaryCase } = await import(pathToFileURL(configTarget).href) as typeof import("./autopilot-config-cases")
  const parentID = "ses_fixture_parent", childID = "ses_fixture_child", workspace = "synthetic-ordinary-workspace"
  const ordinaryAgent = scenario === "custom" ? "3|Custom Explorer" : "explore"
  const caseID = scenario === "custom" ? "copied-producer-data" : "ordinary"
  const resultAt = 11189, holdUntil = resultAt + gate.DEFAULT_PROMPT_ASYNC_POST_DISPATCH_HOLD_MS
  let now = 10000, timerID = 0
  const awaitingHold = Promise.withResolvers<void>()
  const timers = new Map<number, { at: number; run: () => void }>()
  const clock = spyOn(Date, "now").mockImplementation(() => now)
  const nativeSetTimeout = globalThis.setTimeout
  const timerImplementation: typeof setTimeout = Object.assign(<Args extends unknown[]>(
    callback: (...args: Args) => void, delay = 0, ...args: Args
  ) => {
    const id = ++timerID
    timers.set(id, { at: now + Number(delay), run: () => { if (typeof callback === "function") callback(...args) } })
    if (now === resultAt && Number(delay) === gate.DEFAULT_PROMPT_ASYNC_POST_DISPATCH_HOLD_MS) awaitingHold.resolve()
    return id as unknown as ReturnType<typeof setTimeout>
  }, { __promisify__: nativeSetTimeout.__promisify__ })
  const setTimer = spyOn(globalThis, "setTimeout").mockImplementation(timerImplementation)
  const clearTimer = spyOn(globalThis, "clearTimeout").mockImplementation(handle => { timers.delete(Number(handle)) })
  const advance = async (until: number) => {
    while (true) {
      const next = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) break
      now = Math.max(now, next[1].at); timers.delete(next[0]); next[1].run(); await turn()
    }
    now = until; await turn()
  }
  type Data = Record<string, unknown>
  const records: Data[] = [], messages: Data[] = [], attempts: { at: number; caseID: string; taskID: unknown }[] = []
  const gateResults: { at: number; status: string; expiresAt?: number }[] = [], reads: { at: number; route: string }[] = []
  let selected = { id: "", arguments: {} as Data }, resets = 0, dispatched = 0
  const fixture = { workspace, env: { OMO_PROFILE: "qa" }, project: {},
    user: { "[opencode]": { autopilot: { mode: "mandatory" }, agents: { explore: { model: "qa/judge" }, sisyphus: { model: "qa/parent-route" } } } },
    async reset() { resets += 1 }, arguments(values: Data) { return { run_in_background: false, load_skills: [], ...values } } }
  const provider = { records, async select(value: typeof selected) { selected = value } }
  const host = Reflect.construct(TargetHost, [fixture, provider, { exitCode: 0, signalCode: null }, "http://127.0.0.1:1"]) as Host
  host.parent = parentID; host.parentAgent = "sisyphus"; host.ordinaryAgent = ordinaryAgent
  const emit = (type: string, properties: Data) => {
    const event = { type, properties }; host.events.push(event)
    for (const listener of host["listeners"]) listener(event)
  }
  const child = { id: childID, parentID, directory: workspace }
  const status = () => scenario === "active" || scenario === "retry" ? { [childID]: { type: scenario === "active" ? "busy" : "retry" } }
    : scenario === "explicit-idle" ? { [childID]: { type: "idle" } } : {}
  const client = { session: {
    async status() { return { data: dispatched ? status() : {} } },
    async promptAsync() {
      dispatched += 1
      messages.push({ info: { id: `user-${dispatched}`, sessionID: childID, role: "user", agent: ordinaryAgent, tools: {} } })
      records.push({ case_id: selected.id, model: "judge", ordinary_data: true })
      return {}
    },
  } }
  host["document"] = { paths: {
    "/children": { get: { operationId: "session.children" } },
    "/session/status": { get: { operationId: "session.status" } },
    "/session/{id}": { get: { operationId: "session.get", parameters: [{ name: "id", in: "path" }] } },
    "/session/{id}/message": { get: { operationId: "session.messages", parameters: [{ name: "id", in: "path" }] } },
    "/session/{id}/prompt_async": { post: { operationId: "session.promptAsync", parameters: [{ name: "id", in: "path" }] } },
  } }
  const delayed = Promise.withResolvers<Response>(), nativeFetch = globalThis.fetch
  let pendingSignal: AbortSignal | undefined, childLookups = 0
  const unhandled: string[] = [], onUnhandled = (error: unknown) => { unhandled.push(message(error)) }
  process.on("unhandledRejection", onUnhandled)
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input)), route = url.pathname
    assert.equal(url.searchParams.get("directory"), workspace)
    if (route === `/session/${parentID}/prompt_async`) {
      assert(host["listeners"].size > 0, "result listener must precede the trigger")
      attempts.push({ at: now, caseID: selected.id, taskID: selected.arguments.task_id ?? null })
      const result = await gate.dispatchInternalPrompt({ client, sessionID: childID, mode: "async", source: "model-suggestion-retry",
        queueBehavior: "defer", settleMs: 0, checkToolState: false,
        input: { path: { id: childID }, body: { messageID: `prompt-${attempts.length}`, parts: [{ type: "text", text: selected.arguments.prompt }] } } })
      gateResults.push({ at: now, status: result.status, ...(result.status === "reserved" ? { expiresAt: result.expiresAt } : {}) })
      if (attempts.length === 1) {
        assert.equal(result.status, "dispatched", "fixture must reach unchanged real gate")
        emit("session.created", { info: child }); now = resultAt
      }
      emit("message.part.updated", { part: { sessionID: parentID, messageID: `parent-${attempts.length}`,
        callID: `ap2_${selected.id}`, tool: "task", state: { status: "completed", input: selected.arguments,
          output: result.status === "dispatched" ? `ORDINARY_AGENT_OK\nto continue: task(task_id="${childID}")`
            : `Error: promptAsync skipped by gate: ${result.status}` } } })
      return Response.json({})
    }
    if (route === "/children") return Response.json([child])
    if (route === `/session/${childID}/message`) return Response.json(messages)
    if (route === `/session/${childID}`) {
      reads.push({ at: now, route }); childLookups += 1
      if (scenario === "budget" || scenario === "cancel") { pendingSignal = init?.signal ?? undefined; return delayed.promise }
      return Response.json(scenario === "missing-child" ? {} : { ...child,
        ...(scenario === "wrong-child" ? { id: "ses_other" } : {}),
        ...(scenario === "wrong-parent" ? { parentID: "ses_other_parent" } : {}),
        ...(scenario === "wrong-directory" ? { directory: "other-workspace" } : {}) })
    }
    if (route === "/session/status") {
      emit("session.idle", { sessionID: parentID })
      if (childLookups) {
        reads.push({ at: now, route })
        if (scenario === "late-activity") emit("session.status", { sessionID: childID, status: { type: "busy" } })
      }
      return Response.json(scenario === "invalid-status" && childLookups ? null : status())
    }
    throw new Error(`unexpected_ordinary_route:${route}`)
  }, { preconnect: nativeFetch.preconnect })
  let outcome: { status: string; error?: string } = { status: "pending" }
  let output: unknown, pending: Promise<void> | undefined
  gate.releaseAllPromptAsyncReservationsForTesting()
  try {
    // given parent completion during a real reservation, when the ordinary owner continues
    pending = (Reflect.apply(ordinaryCase, undefined, [{ fixture, provider, host },
      ...(scenario === "custom" ? [{ id: caseID, agent: ordinaryAgent, prompt: "Synthetic copied producer data." }] : [])]) as Promise<Data>)
      .then(value => { output = value; outcome = { status: "resolved" } }, error => { outcome = { status: "rejected", error: message(error) } })
    void pending.then(() => awaitingHold.resolve())
    await awaitingHold.promise; await turn()
    emit("session.idle", { sessionID: "ses_other" }); emit("session.idle", { sessionID: parentID })
    if (scenario === "deleted") emit("session.deleted", { info: child })
    if (scenario === "error") emit("session.error", { sessionID: childID })
    if (scenario === "activity") {
      emit("session.status", { sessionID: childID, status: { type: "busy" } })
      emit("session.status", { sessionID: childID, status: { type: "idle" } })
    }
    await advance(12000)
    const atOriginalExpiry = { attempts: attempts.length, dispatched, reads: reads.length }
    await advance(holdUntil - 1)
    const beforeBarrier = { attempts: attempts.length, dispatched, reads: reads.length }
    await advance(holdUntil)
    if (scenario === "cancel") { await host.stop(); await turn() }
    if (scenario === "budget") await advance(resultAt + 20000)
    const beforeLate = { outcome: { ...outcome }, attempts: attempts.length, aborted: pendingSignal?.aborted }
    delayed.resolve(Response.json(child)); await turn()
    await advance(resultAt + 21000)
    assert.notEqual(outcome.status, "pending", "ordinary owner must terminate within its existing phase budget")
    await pending; await host.stop()
    const listenersAfterStop = host["listeners"].size
    gate.releaseAllPromptAsyncReservationsForTesting()
    return { scenario, target, configTarget, holdMs: gate.DEFAULT_PROMPT_ASYNC_POST_DISPATCH_HOLD_MS,
      resultAt, holdUntil, atOriginalExpiry, beforeBarrier, beforeLate, outcome, output, attempts, dispatched,
      gateResults, reads, resets, listenersAfterStop, timersAfterStop: timers.size, unhandled, observations: host.observations }
  } finally {
    delayed.resolve(Response.json(child))
    await host.stop(); gate.releaseAllPromptAsyncReservationsForTesting()
    globalThis.fetch = nativeFetch; process.off("unhandledRejection", onUnhandled)
    clearTimer.mockRestore(); setTimer.mockRestore(); clock.mockRestore()
  }
}

const denialCases = ["before", "after", "fragmented", "ansi", "unowned_child", "child_reuse", "request_expired",
  "wrong-ref", "cause-decoy", "stack-decoy", "wrong-class", "unknown-code", "ambiguous-code", "duplicate-key",
  "duplicate-record", "partial", "truncated-quote", "oversize", "record-bound", "byte-bound", "invalid-utf8",
  "stale", "reused-ref", "old-prefix", "no-stderr", "exit", "stream-end", "stream-close", "stream-error", "cancel",
  "fetch-budget", "body-budget", "correlation-budget", "unrelated-500", "wrong-body-ref", "wrong-error-name", "overlap"] as const
type DenialCase = typeof denialCases[number]
const nativeLine = (fields: Record<string, string> = {}) => Object.entries({ timestamp: "2026-11-01T00:00:00.000Z",
  level: "ERROR", run: "synthetic", message: "failed", ref: "err_1234abcd",
  error: "AutopilotError: request_cancelled\n    at synthetic (fixture.ts:1:1)", cause: "synthetic cause", ...fields,
}).map(([key, value]) => `${key}=${/^[^\s="\\]+$/.test(value) ? value : JSON.stringify(value)}`).join(" ") + "\n"

async function denialProbe(scenario: DenialCase, target: string) {
  const { spyOn } = await import("bun:test")
  const { EventEmitter } = await import("node:events"), { PassThrough } = await import("node:stream")
  const { Host: TargetHost } = await import(pathToFileURL(target).href) as { Host: typeof Host }
  const stderr = new PassThrough(), child = Object.assign(new EventEmitter(), {
    stderr: scenario === "no-stderr" ? null : stderr, exitCode: null as number | null, signalCode: null,
  })
  const host = Reflect.construct(TargetHost, [{ workspace: "synthetic-denial-workspace" }, { records: [] }, child, "http://127.0.0.1:1"]) as Host
  host["document"] = { paths: { "/session/{id}/message": { post: { operationId: "session.prompt", parameters: [{ name: "id", in: "path" }] } } } }
  const nativeFetch = globalThis.fetch, budget = new AbortController(), caller = new AbortController()
  const requestedDeadlines: number[] = [], unhandled: string[] = [], onUnhandled = (error: unknown) => unhandled.push(message(error))
  const deadline = spyOn(AbortSignal, "timeout").mockImplementation(ms => { requestedDeadlines.push(ms); return budget.signal })
  const fetched = Promise.withResolvers<void>(), bodyRead = Promise.withResolvers<void>(), delayedFetch = Promise.withResolvers<Response>()
  const delayedBody = Promise.withResolvers<string>()
  let calls = 0, reached500 = false, bodyCalls = 0, signal: AbortSignal | null | undefined
  const response = () => {
    const value = Response.json({ name: scenario === "wrong-error-name" ? "DifferentError" : "UnknownError",
      data: { message: "Unexpected server error. Check server logs for details.", ref: scenario === "wrong-body-ref" ? "err_abcdef12" : "err_1234abcd" } }, { status: 500 })
    const original = value.text.bind(value)
    Object.defineProperty(value, "text", {
      configurable: true, enumerable: true, writable: true,
      value: (async () => {
        reached500 = true; bodyCalls += 1; bodyRead.resolve()
        return scenario === "body-budget" ? delayedBody.promise : original()
      }) satisfies Response["text"],
    })
    return value
  }
  const emit = (text = nativeLine()) => stderr.write(Buffer.from(text))
  if (scenario === "stale" || scenario === "reused-ref") emit()
  if (scenario === "old-prefix") emit(nativeLine().slice(0, 40))
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    assert.equal(new URL(String(input)).pathname, "/session/ses_denied/message")
    calls += 1; signal = init?.signal; fetched.resolve()
    if (["before", "ansi", "unowned_child", "child_reuse", "request_expired"].includes(scenario)) {
      emit(nativeLine({ error: scenario === "ansi" ? "\u001b[31mAutopilotError: request_cancelled\u001b[0m\nstack"
        : `AutopilotError: ${["unowned_child", "child_reuse", "request_expired"].includes(scenario) ? scenario : "request_cancelled"}\nstack` }))
    }
    return scenario === "fetch-budget" ? delayedFetch.promise : response()
  }, { preconnect: nativeFetch.preconnect })
  process.on("unhandledRejection", onUnhandled)
  let outcome = "pending", pending: Promise<void> | undefined, second: Promise<void> | undefined
  try {
    pending = host.operation("session.prompt", { sessionID: "ses_denied" }, { agent: "autopilot", parts: [] }, caller.signal)
      .then(() => { outcome = "resolved" }, error => { outcome = message(error) })
    await fetched.promise; await turn()
    if (scenario === "overlap") second = host.operation("session.prompt", { sessionID: "ses_denied" }, {}, caller.signal).then(() => undefined, () => undefined)
    if (scenario === "after") emit()
    if (scenario === "fragmented") {
      const bytes = Buffer.from(nativeLine({ cause: "synthetic \u00e4 boundary" }))
      for (const byte of bytes) stderr.write(Buffer.from([byte]))
    }
    if (scenario === "wrong-ref") emit(nativeLine({ ref: "err_abcdef12" }))
    if (scenario === "cause-decoy") emit(nativeLine({ error: "OtherError: failed", cause: "AutopilotError: request_cancelled" }))
    if (scenario === "stack-decoy") emit(nativeLine({ error: "OtherError: failed\nAutopilotError: request_cancelled" }))
    if (scenario === "wrong-class") emit(nativeLine({ error: "OtherError: request_cancelled" }))
    if (scenario === "unknown-code") emit(nativeLine({ error: "AutopilotError: unknown_code" }))
    if (scenario === "ambiguous-code") emit(nativeLine({ error: "AutopilotError: request_cancelled child_reuse" }))
    if (scenario === "duplicate-key") emit(nativeLine().trimEnd() + " ref=err_1234abcd\n")
    if (scenario === "duplicate-record") emit(nativeLine() + nativeLine())
    if (scenario === "partial") emit(nativeLine().trimEnd())
    if (scenario === "truncated-quote") emit('level=ERROR message=failed ref=err_1234abcd error="AutopilotError: request_cancelled\n')
    if (scenario === "oversize") emit(nativeLine({ cause: "x".repeat(17000) }))
    if (scenario === "record-bound" || scenario === "byte-bound") emit(Array.from({ length: 65 }, (_, index) => nativeLine({
      ref: index === 0 ? "err_1234abcd" : `err_${index.toString(16).padStart(8, "0")}`,
      cause: scenario === "byte-bound" ? "x".repeat(16000) : "synthetic cause",
    })).slice(0, scenario === "byte-bound" ? 17 : 65).join(""))
    if (scenario === "invalid-utf8") stderr.write(Buffer.concat([
      Buffer.from(nativeLine({ cause: "" }).trimEnd().slice(0, -1)), Buffer.from([0xff]), Buffer.from('"\n'),
    ]))
    if (scenario === "reused-ref" || scenario === "overlap" || scenario === "wrong-body-ref" || scenario === "wrong-error-name") emit()
    if (scenario === "old-prefix") emit(nativeLine().slice(40))
    if (scenario === "exit") child.emit("exit", 1, null)
    if (scenario === "stream-end") stderr.end()
    if (scenario === "stream-close") stderr.emit("close")
    if (scenario === "stream-error") { stderr.on("error", () => undefined); stderr.emit("error", new Error("synthetic")) }
    if (scenario === "cancel") caller.abort()
    if (["fetch-budget", "body-budget", "correlation-budget"].includes(scenario)) budget.abort()
    await turn()
    const beforeLate = outcome
    caller.abort()
    assert.notEqual(await observe(pending), "observation_deadline", "protected HTTP must settle within its effective deadline")
    delayedFetch.resolve(response()); delayedBody.resolve("{}"); await turn()
    if (!stderr.destroyed && !stderr.writableEnded) emit()
    await second; await turn()
    const afterLate = outcome
    child.exitCode = 0; await host.stop()
    return { target, scenario, calls, reached500, bodyCalls, requestedDeadlines, beforeLate, outcome, afterLate,
      aborted: signal?.aborted, stderrListeners: stderr.listenerCount("data"), exitListeners: child.listenerCount("exit"), unhandled }
  } finally {
    caller.abort(); budget.abort(); delayedFetch.resolve(response()); delayedBody.resolve("{}")
    await pending; child.exitCode = 0; await host.stop(); stderr.destroy()
    globalThis.fetch = nativeFetch; deadline.mockRestore(); process.off("unhandledRejection", onUnhandled)
  }
}

const directProofCases = ["genuine", "extra-provider", "extra-message", "changed-id", "changed-role", "wrong-message-child",
  "missing-child", "wrong-child", "wrong-parent", "wrong-directory", "empty-messages", "duplicate-message", "error-decoy"] as const
type DirectProofCase = typeof directProofCases[number]
async function directProofProbe(scenario: DirectProofCase, target: string, lane: "lifecycle" | "restart") {
  const { mock } = await import("bun:test"), { EventEmitter } = await import("node:events"), { PassThrough } = await import("node:stream")
  const configTarget = path.join(path.dirname(target), "autopilot-config-cases.ts")
  mock.module(configTarget, () => ({ agent: () => undefined, ordinaryCase: async () => ({ child_session_ids: ["ses_ordinary"] }) }))
  const negativesTarget = path.join(path.dirname(target), "autopilot-negative-cases.ts")
  const negatives = await import(pathToFileURL(negativesTarget).href) as typeof import("./autopilot-negative-cases")
  const { Host: TargetHost } = await import(pathToFileURL(target).href) as { Host: typeof Host }
  const stderr = new PassThrough(), child = Object.assign(new EventEmitter(), { stderr, exitCode: null as number | null, signalCode: null })
  const records: Record<string, unknown>[] = [], fixture = { workspace: "synthetic-proof-workspace", arguments: (args = {}) => args,
    assessment: () => "{}" }, provider = { records }
  const host = Reflect.construct(TargetHost, [fixture, provider, child, "http://127.0.0.1:1"]) as Host
  host.parent = "ses_parent"; host.nativeAgent = "old-review-name"
  host["document"] = { paths: {
    "/agent": { get: { operationId: "app.agents" } },
    "/session/{id}": { get: { operationId: "session.get", parameters: [{ name: "id", in: "path" }] } },
    "/session/{id}/message": { get: { operationId: "session.messages", parameters: [{ name: "id", in: "path" }] },
      post: { operationId: "session.prompt", parameters: [{ name: "id", in: "path" }] } },
  } }
  const produced = { provenance: { child_session_id: "ses_denied", prompt_message_id: "msg_user" }, request_digest: "synthetic-digest", invocation_id: "synthetic-invocation" }
  host.invoke = async input => input.id === "custom-name-producer" ? produced : ({ outcome: "human_required",
    error: input.id === "background" ? "background_unsupported" : ["mixed-category", "assessment-authority"].includes(input.id) ? "invalid_request" : "child_reuse" })
  host.verify = async () => ({})
  const nativeFetch = globalThis.fetch
  let prompts = 0, reads = 0, reached500 = false
  const messages = () => {
    const info = { id: "msg_user", sessionID: "ses_denied", role: "user", agent: "old-review-name", system: "synthetic system",
      tools: { "*": false }, model: { providerID: "qa", modelID: "judge" } }
    const result = [{ info, parts: [{ type: "text", text: JSON.stringify({ request_digest: produced.request_digest,
      request: { protocol: "autopilot.gate-request.v1", invocation_id: produced.invocation_id, dispatch: info.model } }) }] },
      { info: { ...info, id: "msg_assistant", role: "assistant" }, parts: [] }]
    if (prompts && scenario === "extra-message") result.push({ info: { ...info, id: "msg_extra" }, parts: [] })
    if (prompts && scenario === "changed-id") result[1].info.id = "msg_changed"
    if (prompts && scenario === "changed-role") result[1].info.role = "user"
    if (prompts && scenario === "wrong-message-child") result[1].info.sessionID = "ses_other"
    if (prompts && scenario === "empty-messages") return []
    if (prompts && scenario === "duplicate-message") result.push(result[1])
    return result
  }
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input)); assert.equal(url.searchParams.get("directory"), fixture.workspace)
    if (url.pathname === "/agent") return Response.json([{ name: "old-review-name", mode: "subagent" }])
    if (url.pathname === "/session/ses_denied") return Response.json(scenario === "missing-child" ? {} : {
      id: scenario === "wrong-child" ? "ses_other" : "ses_denied", parentID: scenario === "wrong-parent" ? "ses_other" : host.parent,
      directory: scenario === "wrong-directory" ? "other-workspace" : fixture.workspace })
    assert.equal(url.pathname, "/session/ses_denied/message")
    if (init?.method === "GET") { reads += 1; return Response.json(messages()) }
    assert.equal(init?.method, "POST"); prompts += 1
    if (scenario === "extra-provider") records.push({ model: "judge" })
    if (scenario === "error-decoy") return Response.json({ info: { error: { name: "OtherError", message: "cause: request_cancelled" } } })
    stderr.write(nativeLine()); reached500 = true
    return Response.json({ name: "UnknownError", data: { message: "Unexpected server error. Check server logs for details.", ref: "err_1234abcd" } }, { status: 500 })
  }, { preconnect: nativeFetch.preconnect })
  let outcome = "pending", restarts = 0
  try {
    const context = { fixture, provider, host }
    const action = lane === "lifecycle" ? Reflect.apply(negatives.lifecycleCases, undefined, [context, produced])
      : Reflect.apply(negatives.historyRestartCase, undefined, [context, async (name: string) => { restarts += 1; host.nativeAgent = name; return host }])
    await (action as Promise<unknown>).then(() => { outcome = "resolved" }, error => { outcome = message(error) })
    return { target, negativesTarget, lane, scenario, outcome, prompts, reads, reached500, restarts, providerCalls: records.length }
  } finally { child.exitCode = 0; await host.stop(); stderr.destroy(); globalThis.fetch = nativeFetch; mock.restore() }
}

if (process.argv[2] === "--qa-denial-probe") {
  const scenario = process.argv[3] as DenialCase, target = process.argv[4]
  assert(denialCases.includes(scenario) && target, "invalid denial probe arguments")
  try { process.stdout.write(JSON.stringify(await denialProbe(scenario, target)) + "\n") }
  catch (error) { process.stderr.write(message(error) + "\n"); process.exitCode = 1 }
} else if (process.argv[2] === "--qa-direct-proof-probe") {
  const scenario = process.argv[3] as DirectProofCase, target = process.argv[4], lane = process.argv[5]
  assert(directProofCases.includes(scenario) && target && (lane === "lifecycle" || lane === "restart"), "invalid direct proof arguments")
  try { process.stdout.write(JSON.stringify(await directProofProbe(scenario, target, lane)) + "\n") }
  catch (error) { process.stderr.write(message(error) + "\n"); process.exitCode = 1 }
} else if (process.argv[2] === "--qa-ordinary-hold-probe") {
  const scenario = process.argv[3] as OrdinaryHoldCase, target = process.argv[4]
  assert(ordinaryHoldCases.includes(scenario) && target, "invalid ordinary hold probe arguments")
  try { process.stdout.write(JSON.stringify(await ordinaryHoldProbe(scenario, target)) + "\n") }
  catch (error) { process.stderr.write(message(error) + "\n"); process.exitCode = 1 }
} else if (process.argv[2] === "--qa-startup-probe") {
  const scenario = process.argv[3] as Case, target = process.argv[4]
  assert(cases.includes(scenario) && target, "invalid probe arguments")
  try { process.stdout.write(JSON.stringify(await probe(scenario, target)) + "\n") }
  catch (error) { process.stderr.write(message(error) + "\n"); process.exitCode = 1 }
} else if (process.argv[2] === "--qa-readiness-probe") {
  const scenario = process.argv[3] as ReadinessCase, target = process.argv[4]
  assert(readinessCases.includes(scenario) && target, "invalid readiness probe arguments")
  try { process.stdout.write(JSON.stringify(await readinessProbe(scenario, target)) + "\n") }
  catch (error) { process.stderr.write(message(error) + "\n"); process.exitCode = 1 }
} else {
  const { describe, expect, test } = await import("bun:test")
  describe("Host SSE startup deadline and cancellation (QA-STARTUP-01)", () => {
    for (const scenario of cases) test(`#given ${scenario} #when subscribing #then startup and resources terminate correctly`, async () => {
      // Child scope contains the fetch replacement and process-level rejection observer.
      const target = path.resolve(process.env.OMO_AP002_QA_HOST_SOURCE ?? fileURLToPath(new URL("./autopilot-host.ts", import.meta.url)))
      const child = Bun.spawn([process.execPath, "--no-env-file", fileURLToPath(import.meta.url),
        "--qa-startup-probe", scenario, target], {
        env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH },
        stdin: "ignore", stdout: "pipe", stderr: "pipe",
      })
      const watchdog = setTimeout(() => child.kill(), 5000)
      try {
        const [exit, stdout, stderr] = await Promise.all([child.exited,
          new Response(child.stdout).text(), new Response(child.stderr).text()])
        expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" })
        const actual = JSON.parse(stdout) as Awaited<ReturnType<typeof probe>>
        expect(actual.target).toBe(target)
        expect(actual.fetchCalls).toBe(1)
        expect(actual.requestedDeadlines).toEqual([15000])
        expect(actual.atOutcome.status).not.toBe("pending")
        expect(actual.observation).not.toBe("observation_deadline")
        expect(actual.unhandled).toEqual([])
        expect(actual.atOutcome.listeners).toBe(0)
        expect(actual.lockedAfterStop).toBe(false)
        expect(actual.stop).toMatchObject({ process_exited: true, sse_closed: true })
        if (scenario === "timely") {
          expect(actual.atOutcome).toMatchObject({ status: "resolved", aborted: false })
          expect(actual.afterLate.events).toEqual(["session.created", "server.connected"])
        } else {
          const error = scenario === "fetch-error" ? "fixture_fetch_failed"
            : scenario === "bad-response" ? "sse_connect_failed"
            : scenario === "stream-error" || scenario === "stream-end" ? "sse_stream_failed"
            : scenario === "cancel-pending" ? "sse_connect_cancelled" : "expected_sse_event_missing"
          expect(actual.atOutcome).toMatchObject({ status: "rejected", error, aborted: true })
          if (scenario !== "wrong-event") expect(actual.afterLate.events).toEqual([])
          expect(actual.afterLate.locked).toBe(false)
          if (scenario === "late-headers" || scenario === "bad-response" || scenario === "wrong-event") {
            expect(actual.afterLate.cancels).toBe(1)
          }
        }
      } finally {
        clearTimeout(watchdog)
        if (child.exitCode === null) child.kill()
        await child.exited
      }
    }, 10000)
  })
  describe("Host discovery and connection order (QA-READINESS-01)", () => {
    for (const scenario of readinessCases) test(`#given ${scenario} #when Host.start runs #then readiness gates actions`, async () => {
      const target = path.resolve(process.env.OMO_AP002_QA_HOST_SOURCE ?? fileURLToPath(new URL("./autopilot-host.ts", import.meta.url)))
      const child = Bun.spawn([process.execPath, "--no-env-file", fileURLToPath(import.meta.url),
        "--qa-readiness-probe", scenario, target], {
        env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      })
      const watchdog = setTimeout(() => child.kill(), 5000)
      try {
        const [exit, stdout, stderr] = await Promise.all([child.exited,
          new Response(child.stdout).text(), new Response(child.stderr).text()])
        expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" })
        const actual = JSON.parse(stdout) as Awaited<ReturnType<typeof readinessProbe>>
        expect(actual.target).toBe(target)
        expect(actual.spawns).toBe(1)
        expect(actual.firstBoundary).toBe("discovery")
        expect(actual.whileDiscoveryHeld).toEqual({ eventRequests: 0, parentRequests: 0, tasks: 0, providerChecks: 0 })
        expect(actual.directories.every(value => value.directory === "synthetic-readiness-workspace")).toBe(true)
        expect(actual.directories.filter(value => value.route === "/agent")).toHaveLength(1)
        expect(actual.lockedAfterStop).toBe(false)
        if (scenario === "fresh" || scenario === "retained") {
          const names = { native: "7|Readiness Judge", parent: "2|Sisyphus (Fixture)", ordinary: "3|Explore - Fixture" }
          expect(actual.outcome).toEqual({ status: "resolved" })
          expect(actual.namesAtSubscribe).toEqual(names)
          expect(actual.names).toEqual(names)
          expect(actual.requestedDeadline).toBe(15000)
          expect(actual.eventRequests).toBe(1)
          expect(actual.parentRequests).toBe(1)
          expect(actual.tasks).toBe(scenario === "fresh" ? 1 : 0)
          expect(actual.providerChecks).toBe(1)
          expect(actual.parent).toBe("synthetic-parent")
          expect(actual.actions.every(value => value.connected)).toBe(true)
          expect(actual.trace).toEqual(["discovery-entered", "discovery-released", "event",
            ...(scenario === "fresh" ? ["parent-create", "task"] : ["parent-get"]), "provider-ready"])
          expect(actual.events).toEqual(["server.connected", "session.created", "message.part.updated", "session.deleted"])
          expect(actual.cancels).toBe(1)
        } else {
          expect(actual.outcome).toEqual({ status: "rejected", error: scenario === "discovery-failure"
            ? "fixture_discovery_failed" : scenario === "invalid-discovery" ? "agent_discovery_invalid" : "native_agents_missing" })
          expect(actual.eventRequests).toBe(0)
          expect(actual.parentRequests).toBe(0)
          expect(actual.tasks).toBe(0)
          expect(actual.providerChecks).toBe(0)
          expect(actual.actions).toEqual([])
          expect(actual.events).toEqual([])
          expect(actual.trace).toEqual(["discovery-entered", "discovery-released"])
        }
      } finally {
        clearTimeout(watchdog)
        if (child.exitCode === null) child.kill()
        await child.exited
      }
    }, 10000)
  })
}

if (!process.argv[2]?.startsWith("--qa-")) {
  const { describe, expect, test } = await import("bun:test")
  async function runDenialChild(flag: string, scenario: string, lane?: string) {
    const target = path.resolve(process.env.OMO_AP002_QA_HOST_SOURCE ?? fileURLToPath(new URL("./autopilot-host.ts", import.meta.url)))
    const child = Bun.spawn([process.execPath, "--no-env-file", fileURLToPath(import.meta.url), flag, scenario, target, ...(lane ? [lane] : [])], {
      env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    })
    const watchdog = setTimeout(() => child.kill(), 5000)
    try {
      const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" })
      return { target, actual: JSON.parse(stdout) }
    } finally { clearTimeout(watchdog); if (child.exitCode === null) child.kill(); await child.exited }
  }
  describe("Native denial observation through public Host.operation (QA-DIRECT-DENIAL-01)", () => {
    for (const scenario of denialCases) test(`#given ${scenario} #when native masks a prompt failure #then exact fresh field/ref proof is required`, async () => {
      const { target, actual } = await runDenialChild("--qa-denial-probe", scenario) as { target: string; actual: Awaited<ReturnType<typeof denialProbe>> }
      expect(actual.target).toBe(target)
      expect(actual.calls).toBeGreaterThan(0)
      expect(actual.requestedDeadlines).toEqual(scenario === "overlap" ? [125000, 125000] : [125000])
      if (scenario !== "fetch-budget") expect(actual.reached500).toBe(true)
      expect(actual.outcome).not.toBe("pending")
      expect(actual.outcome).toBe(actual.afterLate)
      expect(actual.stderrListeners).toBe(0)
      expect(actual.exitListeners).toBe(0)
      expect(actual.unhandled).toEqual([])
      if (["fetch-budget", "body-budget", "correlation-budget", "cancel", "exit", "stream-end", "stream-close", "stream-error"].includes(scenario)) {
        expect(actual.beforeLate).not.toBe("pending")
      }
      if (["before", "after", "fragmented", "ansi", "unowned_child", "child_reuse", "request_expired"].includes(scenario)) {
        const code = ["unowned_child", "child_reuse", "request_expired"].includes(scenario) ? scenario : "request_cancelled"
        // OLD must reach its masked 500 handling and fail this behavioral assertion.
        expect(actual.outcome).toBe(`host_denied:${code}`)
      } else {
        expect(actual.outcome).not.toMatch(/^host_denied:/)
        expect(actual.outcome).not.toBe("resolved")
      }
    }, 10000)
  })
  describe("Both direct denial callers preserve exact child effects (QA-DIRECT-DENIAL-01)", () => {
    for (const lane of ["lifecycle", "restart"] as const) for (const scenario of directProofCases) {
      test(`#given ${lane} ${scenario} #when proving direct denial #then provider and child messages are unchanged`, async () => {
        const { target, actual } = await runDenialChild("--qa-direct-proof-probe", scenario, lane) as { target: string; actual: Awaited<ReturnType<typeof directProofProbe>> }
        expect(actual.target).toBe(target)
        expect(actual.negativesTarget).toBe(path.join(path.dirname(target), "autopilot-negative-cases.ts"))
        if (scenario === "genuine") {
          expect(actual.reached500).toBe(true)
          expect(actual.prompts).toBe(1)
          expect(actual.outcome).toBe("resolved")
          expect(actual.reads).toBeGreaterThanOrEqual(2)
          expect(actual.providerCalls).toBe(0)
        } else {
          expect(actual.outcome).not.toBe("resolved")
          expect(actual.outcome).not.toBe("pending")
          if (["missing-child", "wrong-child", "wrong-parent", "wrong-directory"].includes(scenario)) {
            expect(actual.prompts).toBe(0)
            expect(actual.outcome).toBe("direct_denial_child_mismatch")
          } else {
            expect(actual.prompts).toBe(1)
            const expected = scenario === "extra-provider" ? "direct_denial_provider_changed"
              : ["wrong-message-child", "empty-messages", "duplicate-message"].includes(scenario) ? "direct_denial_messages_invalid"
              : scenario === "error-decoy" ? lane === "lifecycle" ? "direct_old_child_not_rejected" : "restarted_old_child_generation_not_denied"
              : "direct_denial_messages_changed"
            expect(actual.outcome).toBe(expected)
          }
        }
      }, 10000)
    }
  })
}

if (!process.argv[2]?.startsWith("--qa-")) {
  const { describe, expect, test } = await import("bun:test")
  describe("Ordinary continuation native hold prerequisite (NATIVE-R1-01)", () => {
    for (const scenario of ordinaryHoldCases) test(`#given ${scenario} #when ordinaryCase continues #then exact child readiness gates one dispatch`, async () => {
      const target = path.resolve(process.env.OMO_AP002_QA_HOST_SOURCE ?? fileURLToPath(new URL("./autopilot-host.ts", import.meta.url)))
      const child = Bun.spawn([process.execPath, "--no-env-file", fileURLToPath(import.meta.url), "--qa-ordinary-hold-probe", scenario, target], {
        env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      })
      const watchdog = setTimeout(() => child.kill(), 5000)
      try {
        const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
        expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" })
        const actual = JSON.parse(stdout) as Awaited<ReturnType<typeof ordinaryHoldProbe>>
        expect(actual.target).toBe(target)
        expect(actual.configTarget).toBe(path.join(path.dirname(target), "autopilot-config-cases.ts"))
        expect(actual.holdMs).toBe(2000)
        expect(actual.gateResults[0]).toMatchObject({ at: 10000, status: "dispatched" })
        // OLD reaches the real reserved result at 11189; setup failures cannot satisfy this check.
        expect({ early: actual.beforeBarrier, gate: actual.gateResults }).toMatchObject({
          early: { attempts: 1, dispatched: 1, reads: 0 },
        })
        expect(actual.atOriginalExpiry).toEqual({ attempts: 1, dispatched: 1, reads: 0 })
        expect(actual.unhandled).toEqual([])
        expect(actual.listenersAfterStop).toBe(0)
        expect(actual.timersAfterStop).toBe(0)
        expect(actual.resets).toBe(scenario === "custom" ? 0 : 1)
        if (["ordinary", "custom", "explicit-idle"].includes(scenario)) {
          expect(actual.outcome).toEqual({ status: "resolved" })
          expect(actual.attempts).toEqual([{ at: 10000, caseID: scenario === "custom" ? "copied-producer-data" : "ordinary", taskID: null },
            { at: actual.holdUntil, caseID: scenario === "custom" ? "copied-producer-data-continue" : "ordinary-continue", taskID: "ses_fixture_child" }])
          expect(actual.gateResults.map(result => result.status)).toEqual(["dispatched", "dispatched"])
          expect(actual.dispatched).toBe(2)
          expect(actual.reads).toEqual([{ at: actual.holdUntil, route: "/session/ses_fixture_child" },
            { at: actual.holdUntil, route: "/session/status" }, { at: actual.holdUntil, route: "/session/status" }])
          expect(actual.output).toMatchObject({ continuation_executed: true, continuation_child_id: "ses_fixture_child",
            native_user_messages_before: 1, native_user_messages_after: 2 })
        } else {
          expect(actual.outcome.status).toBe("rejected")
          expect(actual.outcome.error).toMatch(/^ordinary_readiness_/)
          expect(actual.attempts).toHaveLength(1)
          expect(actual.dispatched).toBe(1)
          expect(actual.gateResults.map(result => result.status)).toEqual(["dispatched"])
          if (scenario === "budget" || scenario === "cancel") {
            expect(actual.beforeLate.outcome).toEqual(actual.outcome)
            expect(actual.beforeLate.attempts).toBe(1)
            expect(actual.beforeLate.aborted).toBe(true)
            expect(actual.outcome.error).toBe(scenario === "budget" ? "ordinary_readiness_timeout" : "ordinary_readiness_cancelled")
          }
        }
      } finally {
        clearTimeout(watchdog)
        if (child.exitCode === null) child.kill()
        await child.exited
      }
    }, 10000)
  })
}
