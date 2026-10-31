import { ModelDecisionSchema } from "../../packages/omo-opencode/src/features/autopilot/protocol"
import { bounded, check, digest, object } from "./autopilot-evidence"
import type { Data } from "./autopilot-evidence"

export interface Scenario {
  id: string; arguments: Data; backend?: "real" | "fixture"; hold?: string
  child?: "valid" | "malformed" | "read" | "outside" | "bash"
}
function sse(events: Data[]): Response {
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
}
function events(id: number, text: string, tool?: { name: string; arguments: Data; call: string }): Data[] {
  const item = tool ? { type: "function_call", id: `fc_${id}`, call_id: tool.call, name: tool.name, arguments: JSON.stringify(tool.arguments), status: "completed" }
    : { type: "message", id: `msg_${id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }
  return [{ type: "response.created", response: { id: `resp_${id}`, created_at: Math.floor(Date.now() / 1000), model: "qa-fixture" } },
    { type: "response.output_item.added", output_index: 0, item: tool ? { ...item, arguments: "" } : { ...item, content: [] } },
    tool ? { type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: JSON.stringify(tool.arguments) }
      : { type: "response.output_text.delta", item_id: item.id, output_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: `resp_${id}`, status: "completed", output: [item], usage: { input_tokens: 0, output_tokens: 0 } } }]
}
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) return value.flatMap(strings)
  return Object.values(object(value)).flatMap(strings)
}
function envelope(body: Data): Data {
  for (const text of strings(body.input)) {
    const start = text.indexOf('{"request":'), end = text.lastIndexOf("}")
    if (start < 0 || end < start) continue
    try { const value = object(JSON.parse(text.slice(start, end + 1))); if (object(value.request).protocol === "autopilot.gate-request.v1") return value }
    catch { continue }
  }
  return {}
}
function loopbackURL(raw: string): string {
  const url = new URL(raw)
  check(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/", "backend_must_be_local_root_url")
  return url.origin
}
export function startProvider(backendURL?: string) {
  const backend = backendURL ? loopbackURL(backendURL) : undefined
  let scenario: Scenario = { id: "none", arguments: {} }, serial = 0
  const records: Data[] = []
  const holds = new Map<string, { entered: ReturnType<typeof Promise.withResolvers<void>>; release: ReturnType<typeof Promise.withResolvers<void>> }>()
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 255, async fetch(req) {
    const route = new URL(req.url).pathname
    if (route === "/stats") return Response.json({ records })
    if (route === "/health") return Response.json({ ok: true, actual_model_configured: Boolean(backend) })
    if (req.method !== "POST") return new Response(null, { status: 404 })
    const raw = await req.text()
    if (Buffer.byteLength(raw) > 2000000) return new Response(null, { status: 413 })
    const body = object(JSON.parse(raw))
    if (route === "/scenario") { scenario = body as unknown as Scenario; return Response.json({ ok: true }) }
    if (route === "/release") { holds.get(String(body.tag))?.release.resolve(); return Response.json({ released: holds.has(String(body.tag)) }) }
    if (route === "/shutdown") { queueMicrotask(() => server.stop(true)); return Response.json({ stopping: true }) }
    if (route !== "/v1/responses") return new Response(null, { status: 404 })
    const selected = { ...scenario }, id = ++serial, model = String(body.model), captured = envelope(body)
    const request = object(captured.request), policy = object(request.policy)
    const input = Array.isArray(body.input) ? body.input : []
    const completed = (call: string) => input.some(item => object(item).type === "function_call_output" && object(item).call_id === call)
    const record: Data = { id, case_id: selected.id, model, input_sha256: digest(JSON.stringify(body.input ?? [])), request_sha256: digest(raw),
      request_digest: captured.request_digest ?? null, invocation_id: request.invocation_id ?? null,
      policy: Object.fromEntries(["revision", "manifest_digest", "policy_digest", "instruction_digest", "configuration_digest"].map(key => [key, policy[key] ?? null])),
      dispatch: request.dispatch ?? null, model_chain: request.models ?? null, permission_ceiling: request.permission_ceiling ?? null, reasoning: body.reasoning ?? null,
      tools: (Array.isArray(body.tools) ? body.tools : []).map(tool => object(tool).name).filter(name => typeof name === "string"),
      backend: selected.backend === "real" ? "actual-model" : "scripted-transport" }
    check(records.length < 1000, "provider_record_bound"); records.push(record)
    if (model === "parent-route") {
      const call = `ap2_${selected.id}`
      return sse(events(id, "AP2_PARENT_DONE", completed(call) ? undefined : { name: "task", arguments: selected.arguments, call }))
    }
    if (model === "title") return sse(events(id, "Autopilot QA"))
    if (model === "unavailable") return Response.json({ error: { message: "intentional rate limit", type: "rate_limit_error" } }, { status: 429 })
    try {
      if (selected.hold) {
        const hold = holds.get(selected.hold); check(hold, "unregistered_child_latch")
        record.hold = selected.hold; hold.entered.resolve()
        await bounded(hold.release.promise, 60000, "child_latch_timeout")
      }
      if (selected.backend === "real") {
        check(backend, "actual_backend_required")
        const response = await fetch(backend + "/v1/responses", { method: "POST", headers: { "content-type": "application/json" }, body: raw,
          signal: AbortSignal.any([req.signal, AbortSignal.timeout(115000)]) })
        check(response.ok, "actual_backend_http_failure")
        const bytes = await response.text(); check(Buffer.byteLength(bytes) <= 2000000, "actual_backend_response_bound")
        const responseEvents = bytes.split(/\r?\n/).flatMap(line => {
          if (!line.startsWith("data: ") || line === "data: [DONE]") return []
          return [object(JSON.parse(line.slice(6)))]
        })
        const created = responseEvents.filter(event => event.type === "response.created")
        check(created.length === 1, "actual_backend_response_identity_missing")
        const responseID = String(object(created[0].response).id).match(/^resp_(\d+)$/)
        check(responseID?.[1], "actual_backend_response_identity_invalid")
        record.backend_response_id = Number(responseID[1])
        const text = responseEvents.flatMap(event => event.type === "response.output_text.delta" && typeof event.delta === "string" ? [event.delta] : []).join("")
        record.final_sha256 = digest(text)
        try {
          const value: unknown = JSON.parse(text), decision = object(value), parsed = ModelDecisionSchema.safeParse(value)
          const fields = ["protocol", "invocation_id", "request_digest", "outcome", "option_id", "reason_codes", "evidence_ids", "explanation"]
          record.final_contract = { json_valid: true, schema_valid: parsed.success,
            issues: parsed.success ? [] : parsed.error.issues.map(issue => ({ code: issue.code,
              path: issue.path.map(key => typeof key === "number" || fields.includes(String(key)) ? key : "unrecognized") })),
            invocation_matches: decision.invocation_id === request.invocation_id,
            request_digest_matches: decision.request_digest === captured.request_digest,
            evidence_ids_match: Array.isArray(decision.evidence_ids) && decision.evidence_ids.every(value =>
              (Array.isArray(request.evidence) ? request.evidence : []).some(item => object(item).id === value)) }
        } catch { record.final_contract = { json_valid: false } }
        return new Response(bytes, { status: response.status, headers: { "content-type": "text/event-stream" } })
      }
      if (!request.invocation_id) return sse(events(id, "ORDINARY_AGENT_OK"))
      if (selected.child === "malformed") return sse(events(id, '{"protocol":"autopilot.model-decision.v1","outcome":"approve"}'))
      const childCall = `probe_${selected.id}`
      if (["read", "outside", "bash"].includes(selected.child ?? "") && !completed(childCall)) {
        const source = selected.child === "outside" ? "ambient/stale.md" : "evidence/subject.md"
        return sse(events(id, "", { name: selected.child === "bash" ? "bash" : "read", call: childCall,
          arguments: selected.child === "bash" ? { command: "echo forbidden" } : { filePath: source } }))
      }
      return sse(events(id, JSON.stringify({ protocol: "autopilot.model-decision.v1", invocation_id: request.invocation_id,
        request_digest: captured.request_digest, outcome: "approve", reason_codes: ["fixture_transport_only"],
        evidence_ids: (Array.isArray(request.evidence) ? request.evidence : []).map(item => object(item).id), explanation: "Scripted transport control, not model judgment." })))
    } catch { record.failed = true; return Response.json({ error: { message: "qa_provider_failed" } }, { status: 502 }) }
  } })
  return { url: server.url.origin, records,
    async select(next: Scenario) { scenario = next; if (backend && next.backend === "real") {
      const response = await fetch(backend + "/scenario", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ case_id: next.id }), signal: AbortSignal.timeout(5000) })
      check(response.ok, "actual_backend_scenario_failed")
    } },
    latch(tag: string) { check(!holds.has(tag), "duplicate_latch"); const hold = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() }; holds.set(tag, hold)
      return { entered: bounded(hold.entered.promise, 30000, "child_did_not_enter"), release: () => hold.release.resolve() } },
    async backendStats(): Promise<Data[]> { check(backend, "actual_backend_required"); const response = await fetch(backend + "/stats", { signal: AbortSignal.timeout(5000) })
      check(response.ok, "actual_backend_stats_failed"); const data = object(await response.json()); check(Array.isArray(data.records), "actual_backend_stats_invalid"); return data.records.map(object) },
    stop() { for (const hold of holds.values()) hold.release.resolve(); server.stop(true) },
  }
}
export type Provider = ReturnType<typeof startProvider>
