import { writeFile } from "node:fs/promises"
import { check, object } from "./autopilot-evidence"
import type { Data } from "./autopilot-evidence"
import type { Context } from "./autopilot-host"
import { rejected } from "./autopilot-policy-cases"

function block(config: Data): Data { return object(config["[opencode]"]) }
export function agent(context: Context, values: Data): void { object(block(context.fixture.user).agents).autopilot = values }
export async function nativeConfigCases(context: Context): Promise<Data> {
  const { fixture, host, provider } = context, observations: Data[] = []
  const cases: { id: string; model: string; reasoning: string; configure: () => void }[] = [
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
    { id: "custom-variant", model: "judge", reasoning: "deliberate", configure: () => agent(context, { model: "qa/judge", reasoning: "deliberate" }) },
  ]
  for (const test of cases) {
    await fixture.reset(); test.configure(); await fixture.writeConfigs()
    const result = await host.invoke({ id: test.id, arguments: fixture.arguments() }), observed = await host.verify(result, test.model)
    check(object(result.provenance).reasoning === test.reasoning, "native_reasoning_mismatch")
    observations.push({ id: test.id, ...observed })
  }
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
  await fixture.reset(); return { ...evidence, attempted_models: ["qa/unavailable", "qa/judge"], native_children: created.map(info => info.id) }
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
export async function ordinaryCase({ fixture, host, provider }: Context): Promise<Data> {
  await fixture.reset()
  const before = provider.records.length
  const result = await host.invoke({ id: "ordinary", arguments: fixture.arguments({ subagent_type: host.ordinaryAgent, prompt: "Return ORDINARY_AGENT_OK." }) }, true)
  check(typeof result.ordinary_output === "string" && result.ordinary_output.includes("ORDINARY_AGENT_OK"), "ordinary_result_path_failed")
  const children = await host.operation("session.children", { sessionID: host.parent }); check(Array.isArray(children), "ordinary_child_list_invalid")
  const childIDs: string[] = []
  for (const child of children.map(object)) {
    const messages = await host.operation("session.messages", { sessionID: child.id })
    if (Array.isArray(messages) && messages.some(message => object(object(message).info).agent === host.ordinaryAgent)) childIDs.push(String(child.id))
  }
  check(childIDs.length > 0 && provider.records.slice(before).some(record => record.model === "judge" && !record.invocation_id), "ordinary_native_child_missing")
  const continuation = result.ordinary_output.match(/task\(task_id="([^"]+)"/)
  check(continuation?.[1] && childIDs.includes(continuation[1]), "ordinary_continuation_child_mismatch")
  return { parent_session_id: host.parent, child_session_ids: childIDs, ordinary_result_observed: true, continuation_child_id: continuation[1] }
}
