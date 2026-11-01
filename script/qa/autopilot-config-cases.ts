import { writeFile } from "node:fs/promises"
import { check, object, ordinaryMessages } from "./autopilot-evidence"
import type { Data } from "./autopilot-evidence"
import type { Context } from "./autopilot-host"
import { rejected } from "./autopilot-policy-cases"

function block(config: Data): Data { return object(config["[opencode]"]) }
export function agent(context: Context, values: Data): void { object(block(context.fixture.user).agents).autopilot = values }
export async function nativeConfigCases(context: Context): Promise<Data> {
  const { fixture, host, provider } = context, observations: Data[] = []
  const cases: { id: string; model: string; provider?: string; reasoning: string; configure: () => void }[] = [
    { id: "user-model", model: "judge", reasoning: "max", configure: () => {} },
    { id: "project-model", model: "judge-project", reasoning: "high", configure: () => {
      fixture.project["[opencode]"] = { agents: { autopilot: { model: "qa/judge-project", reasoning: "high" } } }
    } },
    { id: "profile-model", model: "judge-profile", reasoning: "max", configure: () => {
      fixture.user.profiles = { qa: { "[opencode]": { agents: { autopilot: { model: "qa/judge-profile", reasoning: "max" } } } } }
    } },
    { id: "category-model", model: "judge-category", reasoning: "high", configure: () => {
      agent(context, { category: "review" }); block(fixture.user).categories = { review: { model: "qa/judge-category", reasoning: "high" } }
    } },
    { id: "direct-over-category", model: "judge-direct", reasoning: "max", configure: () => {
      agent(context, { category: "review", model: "qa/judge-direct", reasoning: "max" })
      block(fixture.user).categories = { review: { model: "qa/judge-category", reasoning: "high" } }
    } },
    { id: "catalog-alias", model: "judge-profile", reasoning: "high", configure: () => {
      fixture.user.models = { selected: { model: "qa/judge-profile", reasoning: "high" } }; agent(context, { model: "selected" })
    } },
    { id: "models-list", model: "judge-direct", reasoning: "max", configure: () => {
      agent(context, { model: "qa/judge", reasoning: "high", models: [{ model: "qa/judge-direct", reasoning: "max" }] })
    } },
    { id: "variant-alias", model: "judge", reasoning: "high", configure: () => agent(context, { model: "qa/judge", variant: "high" }) },
    { id: "effort-alias", model: "judge", reasoning: "high", configure: () => agent(context, { model: "qa/judge", reasoningEffort: "high" }) },
    { id: "alias-collision", model: "judge", reasoning: "high", configure: () => agent(context, { model: "qa/judge", variant: "max", reasoningEffort: "high" }) },
    { id: "canonical-over-aliases", model: "judge", reasoning: "max", configure: () => agent(context, { model: "qa/judge", reasoning: "max", variant: "high", reasoningEffort: "high" }) },
    { id: "native-default-builtin", model: "gpt-6-astra", provider: "openai", reasoning: "max", configure: () => agent(context, { reasoning: "max" }) },
    { id: "custom-variant", model: "judge", reasoning: "deliberate", configure: () => agent(context, { model: "qa/judge", reasoning: "deliberate" }) },
  ]
  for (const test of cases) {
    await fixture.reset(); test.configure(); await fixture.writeConfigs()
    const result = await host.invoke({ id: test.id, arguments: fixture.arguments() }), observed = await host.verify(result, test.model, test.provider)
    check(object(result.provenance).reasoning === test.reasoning, "native_reasoning_mismatch")
    observations.push({ id: test.id, ...observed })
  }
  await fixture.reset(); agent(context, { category: "review" })
  block(fixture.user).categories = { review: { model: "qa/not-available" } }; await fixture.writeConfigs()
  const categoryStart = provider.records.length
  const category = await host.invoke({ id: "category-unavailable", arguments: fixture.arguments() })
  observations.push({ id: "category-unavailable", ...rejected(category, ["invalid_configuration"]) })
  check(!provider.records.slice(categoryStart).some(record => record.invocation_id), "unavailable_category_dispatched_child")
  const invalid: Data[] = [{ model: "qa/not-available" }, { model: "qa/judge", reasoning: "not-supported" },
    { model: "qa/judge", tools: { bash: true } }, { model: "qa/judge", permission: { "*": "allow" } },
    { model: "qa/judge", permission: { external_directory: "allow" } }, { model: "qa/judge", mode: "primary" }]
  for (const [index, values] of invalid.entries()) {
    await fixture.reset(); agent(context, values); await fixture.writeConfigs()
    const before = provider.records.length, result = await host.invoke({ id: `invalid-config-${index}`, arguments: fixture.arguments() })
    observations.push({ id: `invalid-config-${index}`, ...rejected(result, ["invalid_configuration"]) })
    check(!provider.records.slice(before).some(record => record.invocation_id), "invalid_config_dispatched_child")
  }
  await fixture.reset(); await writeFile(fixture.projectConfig, "{")
  const malformed = await host.invoke({ id: "malformed-config", arguments: fixture.arguments() })
  observations.push({ id: "malformed-config", ...rejected(malformed, ["invalid_configuration"]) }); await fixture.reset()
  return { observations, same_parent_continued: host.parent }
}
export async function fallbackCase(context: Context): Promise<Data> {
  const { fixture, host, provider } = context
  await fixture.reset(); object(block(fixture.user).autopilot).limits = { timeout_ms: 120000, max_fallbacks: 1 }
  agent(context, { model: "qa/unavailable", reasoning: "high", fallback_models: [{ model: "qa/judge", reasoning: "max" }] })
  await fixture.writeConfigs()
  const start = host.events.length, result = await host.invoke({ id: "fallback", arguments: fixture.arguments() })
  const evidence = await host.verify(result)
  check(object(result.provenance).fallback_attempt === 1 && object(result.provenance).reasoning === "max", "native_fallback_identity_failed")
  const requests = provider.records.filter(record => record.case_id === "fallback" && record.invocation_id)
  check(requests.some(record => record.model === "unavailable") && requests.some(record => record.model === "judge"), "fallback_provider_attempt_missing")
  const created = host.events.slice(start).filter(event => event.type === "session.created").map(event => object(object(event.properties).info))
  check(new Set(created.filter(info => info.parentID === host.parent).map(info => info.id)).size === 2, "fallback_fresh_children_missing")
  const explicit: Data[] = []
  for (const selection of ["direct", "category", "declared-builtin"] as const) {
    await fixture.reset(); object(block(fixture.user).autopilot).limits = { timeout_ms: 120000, max_fallbacks: 1 }
    agent(context, selection === "category" ? { category: "review" } : { model: "qa/unavailable", reasoning: "high",
      ...(selection === "declared-builtin" ? { fallback_models: [{ model: "openai/gpt-6-astra", reasoning: "max" }] } : {}) })
    if (selection === "category") block(fixture.user).categories = { review: { model: "qa/unavailable", reasoning: "high" } }
    await fixture.writeConfigs()
    const eventStart = host.events.length, id = `explicit-${selection}`
    const output = await host.invoke({ id, arguments: fixture.arguments() })
    const wire = provider.records.filter(record => record.case_id === id && record.invocation_id)
    const children = host.events.slice(eventStart).filter(event => event.type === "session.created")
      .map(event => object(object(event.properties).info)).filter(info => info.parentID === host.parent)
    check(wire.some(record => record.provider_id === "qa" && record.model === "unavailable"), "explicit_primary_not_attempted")
    if (selection === "declared-builtin") {
      const observed = await host.verify(output, "gpt-6-astra", "openai")
      check(object(output.provenance).fallback_attempt === 1 && new Set(children.map(info => info.id)).size === 2,
        "declared_builtin_fallback_missing")
      check(wire.some(record => record.provider_id === "openai" && record.model === "gpt-6-astra"), "builtin_transport_not_exercised")
      explicit.push({ selection, ...observed })
    } else {
      explicit.push({ selection, ...rejected(output, ["native_result_invalid"]) })
      check(wire.every(record => record.provider_id === "qa" && record.model === "unavailable")
        && new Set(children.map(info => info.id)).size === 1, "undeclared_builtin_fallback_dispatched")
    }
  }
  await fixture.reset(); return { ...evidence, attempted_models: ["qa/unavailable", "qa/judge"], native_children: created.map(info => info.id),
    explicit_selection_controls: explicit, builtin_candidate: "openai/gpt-6-astra", builtin_transport: "loopback-controlled; no actual model judgment" }
}
export async function offCases(context: Context): Promise<Data> {
  const { fixture, host, provider } = context, observations: Data[] = []
  for (const mode of ["off", "withdrawn", "project-escalation", "disabled"] as const) {
    await fixture.reset()
    if (mode === "off" || mode === "project-escalation") object(block(fixture.user).autopilot).mode = "off"
    if (mode === "withdrawn" || mode === "project-escalation") fixture.project["[opencode]"] = { autopilot: { format_version: "1", mode: mode === "withdrawn" ? "off" : "on" } }
    if (mode === "disabled") block(fixture.user).disabled_agents = ["autopilot"]
    await fixture.writeConfigs()
    const before = provider.records.length, result = await host.invoke({ id: `authority-${mode}`, arguments: fixture.arguments() })
    observations.push({ mode, ...rejected(result, ["invalid_configuration"]) })
    check(!provider.records.slice(before).some(record => record.invocation_id), "disabled_autopilot_dispatched_child")
  }
  await fixture.reset(); return { observations }
}
export async function ordinaryCase({ fixture, host, provider }: Context, input: { id: string; agent: string; prompt: string } = {
  id: "ordinary", agent: host.ordinaryAgent, prompt: "Return ORDINARY_AGENT_OK.",
}): Promise<Data> {
  if (input.id === "ordinary") await fixture.reset()
  const before = provider.records.length
  const capture: Data | undefined = input.id === "ordinary" && input.agent === host.ordinaryAgent && input.prompt === "Return ORDINARY_AGENT_OK."
    ? { kind: "ordinary_pair", parent_session_id: host.parent, native_pid: host.process.pid,
      preceding_case_id: provider.records.at(-1)?.case_id ?? null, provider_records_before: before, events_before: host.events.length,
      fixture: { reset_before_pair: true, profile: fixture.env.OMO_PROFILE, autopilot_mode: object(block(fixture.user).autopilot).mode,
        ordinary_agent: host.ordinaryAgent, ordinary_model: object(object(block(fixture.user).agents).explore).model,
        parent_agent: host.parentAgent, parent_model: object(object(block(fixture.user).agents).sisyphus).model,
        project_override_present: Object.hasOwn(fixture.project, "[opencode]") } } : undefined
  const captureEventStart = host.events.length
  let capturedChildID: string | undefined
  if (capture) {
    capture.preexisting_child_ids = host.events.filter(event => event.type === "session.created")
      .map(event => object(object(event.properties).info)).filter(info => info.parentID === host.parent).map(info => info.id)
    capture.last_parent_status = object(object(host.events.findLast(event => event.type === "session.status"
      && object(event.properties).sessionID === host.parent)?.properties).status).type ?? null
    host.observations.push(capture)
  }
  try {
    const result = await host.invoke({ id: input.id, ordinary: true, arguments: fixture.arguments({ subagent_type: input.agent, prompt: input.prompt }) }, true)
    check(typeof result.ordinary_output === "string" && result.ordinary_output.includes("ORDINARY_AGENT_OK"), "ordinary_result_path_failed")
    const children = await host.operation("session.children", { sessionID: host.parent }); check(Array.isArray(children), "ordinary_child_list_invalid")
    const continuation = result.ordinary_output.match(/task\(task_id="([^"]+)"/)
    check(continuation?.[1] && children.map(object).some(child => child.id === continuation[1]), "ordinary_continuation_child_mismatch")
    const childID = continuation[1], messages = await host.operation("session.messages", { sessionID: childID })
    capturedChildID = childID
    if (capture) Object.assign(capture, { child_session_id: childID, before_continuation: ordinaryMessages(messages) })
    check(Array.isArray(messages), "ordinary_messages_invalid")
    const users = messages.map(message => object(object(message).info)).filter(info => info.role === "user")
    check(users.length === 1 && users[0].agent === input.agent && object(users[0].tools)["*"] !== false, "ordinary_native_context_missing")
    const eventStart = host.events.length, recordStart = provider.records.length
    if (capture) Object.assign(capture, { continuation_event_start: eventStart, continuation_record_start: recordStart })
    check(typeof result.qa_tool_result_at === "number" && typeof result.qa_tool_result_event_start === "number", "ordinary_readiness_anchor_missing")
    const resumed = await host.invoke({ id: `${input.id}-continue`, ordinary: true, arguments: fixture.arguments({
      subagent_type: input.agent, prompt: "Return ORDINARY_AGENT_OK.", task_id: childID,
    }) }, true, { childID, resultAt: result.qa_tool_result_at, eventStart: result.qa_tool_result_event_start })
    check(typeof resumed.ordinary_output === "string" && resumed.ordinary_output.includes("ORDINARY_AGENT_OK"), "ordinary_continuation_failed")
    const after = await host.operation("session.messages", { sessionID: childID }); check(Array.isArray(after), "ordinary_continuation_history_invalid")
    check(after.filter(message => object(object(message).info).role === "user").length === users.length + 1
      && provider.records.slice(recordStart).some(record => record.model === "judge" && !record.invocation_id), "ordinary_continuation_not_executed")
    check(!host.events.slice(eventStart).some(event => event.type === "session.created" && object(object(event.properties).info).parentID === host.parent),
      "ordinary_continuation_created_replacement")
    check(provider.records.slice(before).filter(record => record.model === "judge").every(record => !record.invocation_id), "ordinary_data_misclassified_by_fixture")
    return { parent_session_id: host.parent, child_session_ids: [childID], ordinary_result_observed: true, continuation_child_id: childID,
      continuation_executed: true, native_user_messages_before: users.length, native_user_messages_after: users.length + 1 }
  } finally {
    if (capture) {
      capture.provider_dispatches = provider.records.slice(before).map(record => Object.fromEntries(
        ["id", "case_id", "model", "provider_id", "ordinary_data", "invocation_id", "backend", "failed"].map(key => [key, record[key] ?? null])))
      const created = (start: number) => host.events.slice(start).filter(event => event.type === "session.created")
        .map(event => object(object(event.properties).info)).filter(info => info.parentID === host.parent)
        .map(info => ({ child_session_id: info.id, parent_session_id: info.parentID }))
      capture.created_children = created(captureEventStart)
      capture.continuation_created_children = typeof capture.continuation_event_start === "number" ? created(capture.continuation_event_start) : null
      if (capturedChildID) {
        try { capture.after_pair = ordinaryMessages(await host.operation("session.messages", { sessionID: capturedChildID })) }
        catch { capture.after_pair = { available: false, error: "ordinary_metadata_readback_failed" } }
      }
    }
  }
}
