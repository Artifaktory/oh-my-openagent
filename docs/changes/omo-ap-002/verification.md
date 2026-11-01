# OMO-AP-002 verification map

[Canonical Issue #2](https://github.com/Artifaktory/oh-my-openagent/issues/2) owns the exact candidate, execution evidence, review ledger and final AC01-AC11 acceptance/gate status. This document defines durable verification surfaces and procedures. A test file, driver case, schema-valid result or passing subset does not establish assembled acceptance.

The authority remains [OMO-AP-001 design 1.0](../omo-ap-001/design.md) and the accepted Issue #2 PLAN2. [Operator configuration](../../reference/configuration.md#autopilot-opencode) and the [implemented protocol](implementation.md) describe the delivered boundary. TaskUpdate/CAS, mandatory completion gating, signing and task/todo effects belong outside this delivery; public results retain `effect: "not_attempted"`.

## Acceptance-to-verification mapping

Owner tests below are existing behavioral surfaces, not declarations that they ran on a later candidate. The [driver evidence registry][driver-evidence] defines fourteen native groups; all are mapped below. AC05 is the assembled quality/review obligation across those groups, not a separate driver case. The [driver][driver] invokes the real OpenCode task path; its [host observer][driver-host] records actual messages, tool results, child/model identities and lifecycle observations. Each criterion requires the applicable deterministic results, bounded native observations and independent disposition recorded in Issue #2.

| Criterion | Existing owner-test surfaces | Native cases and required observations |
| --- | --- | --- |
| **AC01: callable subagent and intended child/model** | [Agent registration][agent-tests], [agent-name schema][name-tests], [named-task interception][task-tests] | `native-task`: isolated Sisyphus parent calls the registered Autopilot name; verify fresh child, native subagent identity and selected provider/model. Registration alone is insufficient. |
| **AC02: scoped result through the parent path** | [Protocol][protocol-tests], [producer/receipt][runtime-tests], [final-result correlation][result-tests], [resume-hook result handling][resume-tests] | `native-task`: parse the entire parent result as JSON, with no continuation tail; correlate invocation/request, task/subject/evidence, policy/configuration and final child/message/model. Owner tests cover decision outcomes and private receipt ownership; public metadata is not a private-receipt proof. |
| **AC03: restricted tools/models and no implicit approval** | [Authority][authority-tests], [native configuration][native-tests], [assessment parser][assessment-tests], [protocol][protocol-tests], [mandatory lifecycle][lifecycle-tests] | `policy-file-negatives`, `native-fallback`, `authority-off`, `lifecycle-rejections`, `malformed-result`, `tool-boundary`, `cancellation`, `short-budget-recovery`: reject invalid/unavailable inputs, malformed or misbound final output, expired/cancelled work and forbidden operations. Verify bounded errors and no expanded authority; a scripted decision after a denied tool does not prove that tool executed. |
| **AC04: ordinary discovery/results and disabled behavior** | [Agent overrides][override-tests], [tool restrictions][tool-tests], [ordinary synchronous task][sync-tests], [continuation][continuation-tests], [mandatory lifecycle][lifecycle-tests], [QA host readiness][host-tests], [resume hook][resume-tests] | `native-task`, `authority-off`, `ordinary-agent`, `custom-name-restart`: verify ordinary result and actual same-child continuation, including copied request-shaped data under a custom ordinary name, and operator-off, project withdrawal/escalation and disabled-agent controls. Missing/invalid authority cannot create approval. Issue #3 TaskUpdate protection is not exercised here. |
| **AC05: complete quality, docs and independent review** | Required commands in [package.json][package] and [CI][ci]; [built-bundle globals][bundle-tests], [built prompt payload][bundle-prompt-tests], [schema freshness][schema-tests], [Knip owner contract][knip-tests], [QA startup/readiness owner][host-tests] | All applicable native groups plus documented schema/loader/parser/example/link/fragment/copy checks. Record complete required test/typecheck/build/quality results and exact source/built bytes; reconcile independent Quality, the existing General/Security Full, triage and required repair Delta against the ledger. Preserve consumed rounds and earlier findings. A successful driver cannot satisfy this gate by itself. |
| **AC06: live rule edit/revert and fresh children** | [Policy capture][policy-tests], [producer][runtime-tests], [continuation rejection][continuation-tests] | `model-policy-ab-revert`: hold task/subject/evidence constant, publish A, B and reverted A as a new publication, then observe actual model decisions in three fresh children under one live parent without rebuild/restart. `lifecycle-rejections` and `custom-name-restart`: reject old-child continuation, including genuine producer history retained across rename/restart. Scripted restart controls cannot prove the model judgment change. |
| **AC07: one consistent invocation snapshot** | [Protocol][protocol-tests], [policy capture][policy-tests], [instruction composition][instruction-tests] | `native-task` and `model-policy-ab-revert`: latch A in flight while B is published; A retains its captured tuple, the next fresh child uses B. Correlate manifest/policy/instruction/configuration digests with request, result and redacted evidence. Capture-time mixed inputs must fail, not merge snapshots. |
| **AC08: editable boundary, precedence and invalid policy** | [Policy capture][policy-tests], [instruction composition][instruction-tests], [native configuration][native-tests] | `model-policy-ab-revert` and `policy-file-negatives`, plus operator-example checks: cover edit/revert, missing/unreadable/invalid/conflicting or unpublished sources. Enrolled guidance cannot replace the fixed protocol/tool ceiling; failure cannot silently use cached policy or broader authority. |
| **AC09: native OD07 configuration** | [Native configuration][native-tests], [validation pipeline][validation-tests], [override schema][override-schema-tests] | `native-config` and `native-fallback`: user/project/profile, category/direct `model` and `models`, catalog and reasoning aliases, declared custom variant, unsupported/unavailable negatives and bounded captured fallback. Record actual effective model/reasoning/configuration identities. No Autopilot-specific vendor prerequisite or universal provider claim follows. |
| **AC10: permission ceiling and parent/child lifecycle** | [Authority][authority-tests], [producer][runtime-tests], [synchronous admission][admission-tests], [mandatory lifecycle][lifecycle-tests], [early renamed-session denial][renamed-denial-tests] | `native-task`, `native-config`, `native-fallback`, `authority-off`, `lifecycle-rejections`, `tool-boundary`, `cancellation`, `short-budget-recovery`, `child-deletion-recovery`, `custom-name-restart`: correlate effective configuration, fresh children, allowed read and denied tool events, old-child/background/mixed-category rejection and parent abort. Owner tests cover the broader read/glob/grep ceiling, stale/unowned contexts, early-discovery deadlines and terminal payload release. Native recovery/restart observations need their own completed, bound results; they do not prove memory-reference release or private receipt ownership. |
| **AC11: multi-file, removal and stale-context matrix** | [Policy capture][policy-tests], [instruction composition][instruction-tests], [producer/registry lifecycle][runtime-tests], [continuation][continuation-tests], [mandatory lifecycle][lifecycle-tests] | `model-policy-ab-revert`, `policy-file-negatives`, `lifecycle-rejections`, `cancellation`, `short-budget-recovery`, `child-deletion-recovery`, `custom-name-restart`: correlate multi-file/removal/partial-publication failures, edit/revert and retained rule/transcript rejection. Owner tests cover configured prompt/append/category/skill/caller-skill composition; native evidence must identify the exact channels actually exercised. |

## Recovery groups and QA readiness

The three recovery groups in [the native negative-case module][negative-cases] extend the original eleven-group procedure:

| Driver group | Procedure and scope of proof |
| --- | --- |
| `short-budget-recovery` | Exercise user and project-tightened provider-response deadlines, reject expired output without a retry, then complete a fresh invocation. This native response latch does not exercise stalled initial model discovery; that regression belongs to [the producer owner tests][runtime-tests]. |
| `child-deletion-recovery` | Delete the active child through the native API, observe its deletion event and bounded rejection, then verify recovery with a fresh child. Registry payload-reference release requires the owner tests and collection inspection; a native event alone cannot prove it. |
| `custom-name-restart` | Retain genuine producer context through a process restart and rename, reject old-child task continuation and direct generation, then execute ordinary generation and same-child continuation with copied producer-shaped text under the former name. Persisted/public metadata never recreates private authority. |

[The QA host owner tests][host-tests] cover prerequisites shared by the driver, including `ordinary-agent` and the ordinary control in `custom-name-restart`. They are controlled regressions, not an additional native group or proof of an actual host run.

- **Startup and discovery:** `Host.start` checks health and API discovery, then resolves `app.agents` in the same workspace before subscribing to events. Health/API availability alone does not establish project readiness. Agent identities and subagent mode must be valid. Parent creation or retained-parent lookup, task setup and provider checks follow the established event subscription, preserving coverage of their lifecycle events.
- **SSE deadline and cleanup:** observe connection establishment and its pending fetch together, retaining the 15-second `server.connected` deadline. Failure, wrong/late/missing events, failed or ended streams and cancellation abort/clean up the pending connection. The ten `QA-STARTUP-01` owner cases and six `QA-READINESS-01` cases preserve those distinctions. Late connection evidence is a failure, not a relaxed deadline.
- **Ordinary continuation:** after a successful first tool result, the QA waits for the existing [2-second post-dispatch hold][gate-timing], using that result as a conservative later anchor. Parent idle alone is insufficient. It then reads the exact child's fresh session identity, parent and workspace directory, followed by fresh status. An omitted idle entry is acceptable only after that existence/lineage check. The 20-second QA readiness budget is anchored to the same first result; activity, error, deletion, stream, cancellation and deadline guards remain active through the continuation trigger.
- **Observable continuation:** send one continuation to that same child after readiness, then require the expected result, one additional user message, a real child dispatch and no replacement child. The sixteen `NATIVE-R1-01` owner cases cover positive/custom/explicit-idle paths and identity, activity, lifecycle and budget rejection. This prerequisite changes neither the gate default nor the Autopilot old-child negative assertions; no reserved-result retry or bypass is part of the procedure.

Controlled OLD/FIXED checks must compare the same owner tests with separately bound old and repaired QA modules. A failure caused by a missing export or setup error does not reproduce the hold defect. Keep these results distinct from real host execution and independent repair disposition.

## Strict native direct-denial proof

The [lifecycle and restart callers][negative-cases] use the same direct-denial procedure for `lifecycle-rejections` and `custom-name-restart`. It supports AC03/AC06/AC10/AC11, with AC05 retaining the assembled qualification gate. A generic HTTP failure cannot prove the intended guard rejected a request.

1. **Observe the isolated native process.** [QA fixtures][qa-fixtures] set `OPENCODE_PRINT_LOGS=1` and `OPENCODE_LOG_LEVEL=ERROR` only in their isolated environment. [Host][driver-host] attaches the [native denial observer][native-denial] before the target `session.prompt` request and begins a capture for that request's selected child. No global logging configuration is changed.
2. **Require a complete error record.** The observer assembles complete LF-terminated physical byte lines, then decodes strict UTF-8 and parses logfmt with unique field keys and complete quoted values. Fragmented bytes, including split UTF-8 characters, are acceptable only after the complete line arrives. For a masked HTTP 500, require the expected `UnknownError` shape and exact `data.ref` match to a fresh native record with `level=ERROR` and `message=failed`. After ANSI color removal, the first header of the actual `error` field must be exactly `AutopilotError: <known code>`. The allowed codes are `unowned_child`, `child_reuse`, `request_cancelled` and `request_expired`. A match in `cause`, later stack text or an unrelated field is insufficient. An explicitly exposed typed `AutopilotError` is recognized only with one unambiguous known message code; arbitrary response-text searches are not evidence.
3. **Keep correlation bounded.** The capture is tied to the selected request/child; the reference joins its HTTP response to the native error record, while the caller's session checks establish child lineage. The observer limits each line to 16384 bytes, each request to 262144 bytes and 64 records, and remembered references to 4096 per observer. Wrong/missing references, stale or reused references, duplicate keys/records, overlapping captures, invalid UTF-8, unknown/ambiguous error headers and truncated, oversized or unfinished frames cannot qualify a denial. Fetch, response-body reading and error correlation share the existing HTTP abort signal, at most 125000 ms or an earlier supplied/host abort. There is no fresh correlation deadline or retry. Request finalization clears its capture and abort listener; native exit, stderr termination/error and Host stop dispose the observer. Only bounded correlation metadata is retained, not raw stderr/error bodies.
4. **Prove unchanged child effects in both paths.** Before and after direct generation, read the same child's identity, parent and workspace directory. Read its complete bounded message list, requiring 1-4096 entries with unique nonempty IDs, matching child IDs and valid user/assistant roles. Compare the sorted message ID/role snapshots and require unchanged provider-record count. Missing/wrong lineage, extra provider activity, added/replaced message IDs or changed roles fail the procedure even if a specific denial was observed. This proves the checked identities/counts, not byte equality of all message contents or private receipt ownership.

### Controlled owner coverage and observed scope

The existing [Host owner specification][host-tests] contains 95 cases. Its original 32 controls remain: ten startup, six discovery/readiness and sixteen ordinary-continuation hold cases. The 63 added cases comprise 37 public `Host.operation` denial-observation cases and thirteen child/provider proof cases for each of the two lifecycle/restart callers. They cover complete and fragmented records, field/reference decoys, bounds, stale/overlapping captures, fetch/body/correlation cancellation, observer cleanup, exact child lineage and unchanged message/provider observations.

The recorded controlled comparison on 2026-11-01 used the same final owner specification against separately bound OLD and FIXED QA modules: OLD completed with 60 pass / 35 fail in 18.162 s; FIXED completed with 95 pass / 0 fail in 12.064 s. All original 32 controls passed in both. The causal assessment records seven OLD masked-500 observations reaching `host_http_500`, with failures confined to added cases and no setup failure. These are Main's implementation-validation results for controlled transports, not independent approval, real native/model execution or a platform-wide PASS. Exact inputs, the earlier compiler failure/correction and result identities remain in the canonical Issue ledger and local records. Full native coverage and independent Quality/Delta still require their own evidence.

## Isolated QA roots

The expanded configuration and fallback controls must not consume all slots of one long-lived test root before later negative cases reach their intended child boundary. The native default root-descendant limit remains 24; it is never raised, disabled or reset to make this QA pass.

The [driver][driver] completes `native-task` through `malformed-result` in the first isolated fixture, verifies that fixture's original task, subject and evidence identities, records its host observations and stops/removes it. It then creates a fresh isolated fixture, native process and parent for `tool-boundary` and the remaining four groups. No existing task thread or parent is rewritten. A/B/revert and the original-child lifecycle checks keep their actual first parent; custom-name restart retains its own second-fixture parent and task.

[Root lifetime accounting][root-isolation] records a baseline before each fixture's group calls and verifies it again at completion, on failure and around retained-parent restarts. Every fixture and host has its own setup, no-effect and cleanup record, including partial setup or failed stop. Incomplete setup is not a no-effect PASS. The executor must inspect all fixture records and the global database invariant; a final fixture's success cannot hide an earlier failure.

The eight [root-isolation owner cases][root-tests] exercise the actual driver body and tool-case entry with controlled workload/host ports and the existing default capacity. They cover the exhausted old root, a fresh root reaching the intended tool boundary, task/subject/evidence changes, partial fixture/start failures, retained-parent restart and stop failure. This controlled comparison does not execute the real manager or model and does not supply native qualification. All fourteen native groups, the original 95 Host controls and all eleven acceptance obligations remain required under their existing recorded scope.

## Required execution and interpretation

The authorized Quality/host owner uses the project's existing commands and [OpenCode QA procedure][qa-skill]. Start from the complete candidate identity, not HEAD alone when changes are uncommitted. Record base/HEAD, full patch and file-manifest digests, test/driver revisions, built plugin digest, platform/runtime/SDK, selected configuration and model/backend identity. Reconcile later source, docs or build changes explicitly; never relabel an earlier execution as a test of later bytes.

1. Run the applicable owner tests and required repository gates, including the full root suite, configured typecheck/build and remaining required quality/artifact checks. Preserve exact arguments, exits, duration, complete/incomplete status and source/index readbacks. Tracked-only scans need explicit coverage of new candidate paths. Missing, cancelled, failed or unevaluable checks do not satisfy a gate.
2. Validate operator examples through the actual [authority schema][authority-schema], [agent schema][agent-schema], [native loader][native-loader] and [Autopilot projection][native-projection]. Parse the policy example through [PolicyManifestSchema][manifest-schema] and confirm its exact UTF-8/LF payload hash. Exercise supported aliases/custom variants and unsupported inputs without changing global settings.
3. Drive the existing native cases using isolated user/project and XDG/data/config/state/cache paths, the local built plugin and the selected real OpenCode binary. The [driver][driver] accepts `--mode real`, explicit producer/driver manifests, plugin, binary, backend identity and a bounded budget. Its real mode needs an authorized local backend for unmodified A/B/revert model output. Fixture mode exits 2 with actual-model evidence incomplete; real-mode exit 0 means driver checks passed with acceptance still pending.
4. Capture task/tool and mandatory chat/system/messages/params observations, source and result identities, isolation and cleanup. Record transport and actual backend model separately. Compare real database session counts through the authorized executor; do not inspect credentials or copy sensitive policies, prompts, evidence or raw model transcripts into docs.
5. Validate documentation links, complete public JSON parsing, reserved [fragment 5][fragment] and the repository's `check:copy` requirements with the actual parsers/owner checks. Do not add wording snapshots, prose-pin assertions or duplicate tests. Freeze the assembled candidate after checks for independent review.

These procedures are requirements for the assigned executor. The documentation implementer does not run or self-certify them. Further native runs require a reason and the existing scope/budget; this map does not authorize unchanged retries.

## Observed qualification on 2026-10-30

The historical run used **Windows x64, OpenCode 1.19.4 and SDK 1.18.31**. Its exact source/driver, built-plugin and result bindings belong to the [Issue #2 evidence ledger](https://github.com/Artifaktory/oh-my-openagent/issues/2) and retained local records. This dated result applies only to that recorded eleven-group procedure and its inputs; it does not qualify later candidate bytes or the three added recovery groups.

All eleven groups registered for that historical run completed with `driver_checks_passed_acceptance_pending`. Ten groups used scripted provider decisions on the real host. Only `model-policy-ab-revert` used actual `gpt-6-astra/max` judgment through the `qa/judge` transport bridge: **approve / rework / approve**, with one parent, three fresh children, fixed task/subject/evidence and an explicit in-flight latch. Request/output hashes correlated with backend records. The managed Codex backend supplied additional system/tool context beyond the OpenCode conversation. This does not establish closed provider internals, all-provider reasoning support or universal host compatibility.

The authorized executor recorded source unchanged, isolated paths, unchanged real database session counts, process exit, SSE closure and temporary-root cleanup. These observations were assessed from local redacted evidence; this documentation role did not inspect the global database or credentials.

| Other recorded lane | Bounded meaning |
| --- | --- |
| Full build and configured typecheck on the native run's source manifest | Both completed with exit 0. Their source/build identity is retained; later candidate applicability belongs to Quality. |
| Confirmed Knip correction | The separately recorded completed Knip correction records the existing `script/knip-coverage.test.ts` owner check and `bun run knip:check` both exiting 0, with source/index unchanged. This is GREEN for those checks only. The earlier confirmed failure and repair lineage remain preserved. |
| Windows root verification | Earlier failed/incomplete runs, runner index contamination and cancellation/termination uncertainty retain their original records. The later selected-Windows root-entry assessment is a separate ledger disposition. Partial pass counts cannot become a complete root-suite PASS. |
| Linux unchanged-base prerequisite sample | 59 cases passed across `test-hermetic-home.test.ts`, `script/agent-cleanup-hook.test.ts` and `script/agent-harness-wiring.test.ts` on base `23d3eb74f68ec6c23a23d24b0c310b1e5a9a516f`. This establishes representative prerequisites on that base, not candidate qualification or a full Linux/root-suite PASS. |

## Acceptance and review handoff

Reconcile every AC01-AC11 row with the canonical Issue ledger: identify the checked candidate and environment, actual outcome, evidence applicability, confirmed finding IDs, independent review/triage disposition and remaining owner action. Preserve the existing Full and repair history and consumed budgets. A new document, controlled regression or passing native subset cannot close a pending acceptance criterion or reset a review round.

The ledger retains the earlier fourteen-group attempt with seven groups passed, a direct-denial check failure and six groups not run, plus the later bounded six-group diagnostic under its own source and budget limits. Those records cannot be combined into a completed full run. A startup-only failure supplies no group result. Current native outcomes, cleanup and independent dispositions remain ledger-owned; this procedure does not predict them.

Historical Linux failures and unresolved causal observations, skipped tests, the failed complete Codex command despite a corrected focused owner, and Senpi environment failures keep their original outcomes. Applicable later compatibility, web, platform and remote checks need their own ledger evidence; no blanket cross-platform PASS follows.

Main records actual check completion, freezes the complete candidate and binds all independent reviewers to the same base/HEAD/patch. Triage precedes confirmed repairs; Delta applies only to real repairs and their direct regressions. If documentation changes after runtime checks, Main verifies the document preimages and records the new documentation/source-manifest identity separately. Quality assesses whether unchanged runtime source, QA and bundle bytes preserve the earlier runtime evidence, and checks the changed documentation; source manifests that include those documents receive a new identity; the earlier run is never relabelled as execution on the new manifest. Independent Delta assesses the repaired findings and directly affected mapping. Local qualification, publication and human merge/release decisions remain separate. Current operational evidence and decisions belong in the [Issue #2 evidence, review and acceptance ledger](https://github.com/Artifaktory/oh-my-openagent/issues/2), with redacted raw histories kept locally.

[driver]: ../../../script/qa/autopilot.ts
[driver-evidence]: ../../../script/qa/autopilot-evidence.ts
[driver-host]: ../../../script/qa/autopilot-host.ts
[agent-tests]: ../../../packages/omo-opencode/src/agents/utils.test.ts
[name-tests]: ../../../packages/omo-opencode/src/config/schema/agent-names.test.ts
[task-tests]: ../../../packages/omo-opencode/src/tools/delegate-task/autopilot-task.test.ts
[protocol-tests]: ../../../packages/omo-opencode/src/features/autopilot/protocol.test.ts
[runtime-tests]: ../../../packages/omo-opencode/src/features/autopilot/autopilot-runtime.test.ts
[result-tests]: ../../../packages/omo-opencode/src/tools/delegate-task/sync-result-fetcher.test.ts
[resume-tests]: ../../../packages/omo-opencode/src/hooks/task-resume-info/index.test.ts
[authority-tests]: ../../../packages/omo-opencode/src/features/autopilot/authority.test.ts
[native-tests]: ../../../packages/omo-opencode/src/features/autopilot/native-config.test.ts
[assessment-tests]: ../../../packages/omo-opencode/src/features/autopilot/decision-validation.test.ts
[lifecycle-tests]: ../../../packages/omo-opencode/src/plugin/autopilot-lifecycle.test.ts
[override-tests]: ../../../packages/omo-opencode/src/agents/builtin-agents/agent-overrides.test.ts
[tool-tests]: ../../../packages/omo-opencode/src/agents/tool-restrictions.test.ts
[sync-tests]: ../../../packages/omo-opencode/src/tools/delegate-task/sync-task.test.ts
[bundle-tests]: ../../../packages/omo-opencode/src/shared/dist-bundle-bun-globals.test.ts
[bundle-prompt-tests]: ../../../packages/omo-opencode/src/shared/dist-bundle-prompt-content.test.ts
[schema-tests]: ../../../tests/omo-schema-freshness.test.ts
[knip-tests]: ../../../script/knip-coverage.test.ts
[policy-tests]: ../../../packages/omo-opencode/src/features/autopilot/policy-snapshot.test.ts
[instruction-tests]: ../../../packages/omo-opencode/src/features/autopilot/instruction-snapshot.test.ts
[continuation-tests]: ../../../packages/omo-opencode/src/tools/delegate-task/autopilot-continuation.test.ts
[validation-tests]: ../../../packages/omo-opencode/src/config/validate-pipeline.test.ts
[override-schema-tests]: ../../../packages/omo-opencode/src/config/schema/agent-overrides.test.ts
[admission-tests]: ../../../packages/omo-opencode/src/tools/delegate-task/sync-task-admission.test.ts
[package]: ../../../package.json
[ci]: ../../../.github/workflows/ci.yml
[qa-skill]: ../../../.agents/skills/opencode-qa/SKILL.md
[authority-schema]: ../../../packages/omo-opencode/src/config/schema/autopilot.ts
[agent-schema]: ../../../packages/omo-opencode/src/config/schema/agent-overrides.ts
[native-loader]: ../../../packages/omo-opencode/src/plugin-config/omo-config-chain.ts
[native-projection]: ../../../packages/omo-opencode/src/features/autopilot/native-config.ts
[manifest-schema]: ../../../packages/omo-opencode/src/features/autopilot/policy-schema.ts
[fragment]: ../../../changes/unreleased/5.md

[host-tests]: ../../../script/qa/autopilot-host.test.ts
[negative-cases]: ../../../script/qa/autopilot-negative-cases.ts
[gate-timing]: ../../../packages/utils/src/prompt-async-gate/timing.ts

[native-denial]: ../../../script/qa/autopilot-native-denial.ts
[qa-fixtures]: ../../../script/qa/autopilot-fixtures.ts

[root-isolation]: ../../../script/qa/autopilot-root-isolation.ts
[root-tests]: ../../../script/qa/autopilot-root-isolation.test.ts

[renamed-denial-tests]: ../../../packages/omo-opencode/src/plugin/autopilot-renamed-denial.test.ts
