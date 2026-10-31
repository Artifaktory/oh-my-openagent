# OMO-AP-002 verification map

[Canonical Issue #2](https://github.com/Artifaktory/oh-my-openagent/issues/2) owns the exact candidate, execution evidence, review ledger and final AC01-AC11 acceptance/gate status. This document defines durable verification surfaces and procedures. A test file, driver case, schema-valid result or passing subset does not establish assembled acceptance.

The authority remains [OMO-AP-001 design 1.0](../omo-ap-001/design.md) and the accepted Issue #2 PLAN2. [Operator configuration](../../reference/configuration.md#autopilot-opencode) and the [implemented protocol](implementation.md) describe the delivered boundary. TaskUpdate/CAS, mandatory completion gating, signing and task/todo effects belong outside this delivery; public results retain `effect: "not_attempted"`.

## Acceptance-to-verification mapping

Owner tests below are existing behavioral surfaces, not declarations that they ran on a later candidate. Native case IDs come from the [driver evidence registry][driver-evidence]. The [driver][driver] invokes the real OpenCode task path; its [host observer][driver-host] records actual messages, tool results, child/model identities and lifecycle observations. Each criterion requires the applicable deterministic results, bounded native observations and independent disposition recorded in Issue #2.

| Criterion | Existing owner-test surfaces | Native cases and required observations |
| --- | --- | --- |
| **AC01: callable subagent and intended child/model** | [Agent registration][agent-tests], [agent-name schema][name-tests], [named-task interception][task-tests] | `native-task`: isolated Sisyphus parent calls the registered Autopilot name; verify fresh child, native subagent identity and selected provider/model. Registration alone is insufficient. |
| **AC02: scoped result through the parent path** | [Protocol][protocol-tests], [producer/receipt][runtime-tests], [final-result correlation][result-tests], [resume-hook result handling][resume-tests] | `native-task`: parse the entire parent result as JSON, with no continuation tail; correlate invocation/request, task/subject/evidence, policy/configuration and final child/message/model. Owner tests cover decision outcomes and private receipt ownership; public metadata is not a private-receipt proof. |
| **AC03: restricted tools/models and no implicit approval** | [Authority][authority-tests], [native configuration][native-tests], [assessment parser][assessment-tests], [protocol][protocol-tests], [mandatory lifecycle][lifecycle-tests] | `policy-file-negatives`, `native-fallback`, `authority-off`, `lifecycle-rejections`, `malformed-result`, `tool-boundary`, `cancellation`: reject invalid/unavailable inputs, malformed or misbound final output, expired/cancelled work and forbidden operations. Verify bounded errors and no expanded authority; a scripted decision after a denied tool does not prove that tool executed. |
| **AC04: ordinary discovery/results and disabled behavior** | [Agent overrides][override-tests], [tool restrictions][tool-tests], [ordinary synchronous task][sync-tests], [resume hook][resume-tests] | `native-task`, `authority-off`, `ordinary-agent`: verify ordinary result/continuation behavior and operator-off, project withdrawal/escalation and disabled-agent controls. Missing/invalid authority cannot create approval. Issue #3 TaskUpdate protection is not exercised here. |
| **AC05: complete quality, docs and independent review** | Required commands in [package.json][package] and [CI][ci]; [built-bundle globals][bundle-tests], [built prompt payload][bundle-prompt-tests], [schema freshness][schema-tests], [Knip owner contract][knip-tests] | All applicable native groups plus documented schema/loader/parser/example/link/fragment/copy checks. Record complete required test/typecheck/build/quality results, exact source and built bytes, then independent Quality completion, General/Security Full and separate triage. A successful driver cannot satisfy this gate by itself. |
| **AC06: live rule edit/revert and fresh children** | [Policy capture][policy-tests], [producer][runtime-tests], [continuation rejection][continuation-tests] | `model-policy-ab-revert` and `lifecycle-rejections`: hold task/subject/evidence constant, publish A, B and reverted A as a new publication, then observe actual model decisions in three fresh children under one live parent without rebuild/restart. Reject an old-child continuation. Scripted responses cannot prove the judgment change. |
| **AC07: one consistent invocation snapshot** | [Protocol][protocol-tests], [policy capture][policy-tests], [instruction composition][instruction-tests] | `native-task` and `model-policy-ab-revert`: latch A in flight while B is published; A retains its captured tuple, the next fresh child uses B. Correlate manifest/policy/instruction/configuration digests with request, result and redacted evidence. Capture-time mixed inputs must fail, not merge snapshots. |
| **AC08: editable boundary, precedence and invalid policy** | [Policy capture][policy-tests], [instruction composition][instruction-tests], [native configuration][native-tests] | `model-policy-ab-revert` and `policy-file-negatives`, plus operator-example checks: cover edit/revert, missing/unreadable/invalid/conflicting or unpublished sources. Enrolled guidance cannot replace the fixed protocol/tool ceiling; failure cannot silently use cached policy or broader authority. |
| **AC09: native OD07 configuration** | [Native configuration][native-tests], [validation pipeline][validation-tests], [override schema][override-schema-tests] | `native-config` and `native-fallback`: user/project/profile, category/direct `model` and `models`, catalog and reasoning aliases, declared custom variant, unsupported/unavailable negatives and bounded captured fallback. Record actual effective model/reasoning/configuration identities. No Autopilot-specific vendor prerequisite or universal provider claim follows. |
| **AC10: permission ceiling and parent/child lifecycle** | [Authority][authority-tests], [producer][runtime-tests], [synchronous admission][admission-tests], [mandatory lifecycle][lifecycle-tests] | `native-task`, `native-config`, `native-fallback`, `authority-off`, `lifecycle-rejections`, `tool-boundary`, `cancellation`: correlate effective configuration, fresh children, allowed read and denied tool events, old-child/background/mixed-category rejection and parent abort. Owner tests cover the broader read/glob/grep ceiling and stale/unowned contexts; any actual restart/resume claim needs separately identified execution evidence. |
| **AC11: multi-file, removal and stale-context matrix** | [Policy capture][policy-tests], [instruction composition][instruction-tests], [continuation][continuation-tests], [mandatory lifecycle][lifecycle-tests] | `model-policy-ab-revert`, `policy-file-negatives`, `lifecycle-rejections`, `cancellation`: correlate multi-file/removal/partial-publication failures, edit/revert and retained rule/transcript rejection. Owner tests cover configured prompt/append/category/skill/caller-skill composition; native evidence must identify the exact channels actually exercised. |

## Required execution and interpretation

The authorized Quality/host owner uses the project's existing commands and [OpenCode QA procedure][qa-skill]. Start from the complete candidate identity, not HEAD alone when changes are uncommitted. Record base/HEAD, full patch and file-manifest digests, test/driver revisions, built plugin digest, platform/runtime/SDK, selected configuration and model/backend identity. Reconcile later source, docs or build changes explicitly; never relabel an earlier execution as a test of later bytes.

1. Run the applicable owner tests and required repository gates, including the full root suite, configured typecheck/build and remaining required quality/artifact checks. Preserve exact arguments, exits, duration, complete/incomplete status and source/index readbacks. Tracked-only scans need explicit coverage of new candidate paths. Missing, cancelled, failed or unevaluable checks do not satisfy a gate.
2. Validate operator examples through the actual [authority schema][authority-schema], [agent schema][agent-schema], [native loader][native-loader] and [Autopilot projection][native-projection]. Parse the policy example through [PolicyManifestSchema][manifest-schema] and confirm its exact UTF-8/LF payload hash. Exercise supported aliases/custom variants and unsupported inputs without changing global settings.
3. Drive the existing native cases using isolated user/project and XDG/data/config/state/cache paths, the local built plugin and the selected real OpenCode binary. The [driver][driver] accepts `--mode real`, explicit producer/driver manifests, plugin, binary, backend identity and a bounded budget. Its real mode needs an authorized local backend for unmodified A/B/revert model output. Fixture mode exits 2 with actual-model evidence incomplete; real-mode exit 0 means driver checks passed with acceptance still pending.
4. Capture task/tool and mandatory chat/system/messages/params observations, source and result identities, isolation and cleanup. Record transport and actual backend model separately. Compare real database session counts through the authorized executor; do not inspect credentials or copy sensitive policies, prompts, evidence or raw model transcripts into docs.
5. Validate documentation links, complete public JSON parsing, reserved [fragment 5][fragment] and the repository's `check:copy` requirements with the actual parsers/owner checks. Do not add wording snapshots, prose-pin assertions or duplicate tests. Freeze the assembled candidate after checks for independent review.

These procedures are requirements for the assigned executor. The documentation implementer does not run or self-certify them. Further native runs require a reason and the existing scope/budget; this map does not authorize unchanged retries.

## Observed qualification on 2026-10-30

The recorded run used **Windows x64, OpenCode 1.19.4 and SDK 1.18.31**, with plugin SHA-256 `962c65abe1c0ac9b480ef7ef9decab1ea8f45b802c65b573aade0b030dcee109`. Its source/driver manifest SHA-256 was `bb1a6791a091df60a140fae6f5fff421ebb36e27abcffc75aaf0f1254d207b35`; the native result SHA-256 was `799d0799a2bc2d73d8e5c07ea9fc24683e2df24f2776c87c2a57ef924a858bfb`. These identify that observed run, not a final HEAD or later assembled candidate.

All eleven driver groups in the mapping completed with `driver_checks_passed_acceptance_pending`. Ten groups used scripted provider decisions on the real host. Only `model-policy-ab-revert` used actual `gpt-6-astra/max` judgment through the `qa/judge` transport bridge: **approve / rework / approve**, with one parent, three fresh children, fixed task/subject/evidence and an explicit in-flight latch. Request/output hashes correlated with backend records. The managed Codex backend supplied additional system/tool context beyond the OpenCode conversation. This does not establish closed provider internals, all-provider reasoning support or universal host compatibility.

The authorized executor recorded source unchanged, isolated paths, unchanged real database session counts (378 before and after), process exit, SSE closure and temporary-root cleanup. These observations were assessed from local redacted evidence; this documentation role did not inspect the global database or credentials.

| Other recorded lane | Bounded meaning |
| --- | --- |
| Full build and configured typecheck on the native run's source manifest | Both completed with exit 0. Their source/build identity is retained; later candidate applicability belongs to Quality. |
| Confirmed Knip correction | The subsequent complete `confirmed-knip-fix-01` result records the existing `script/knip-coverage.test.ts` owner check and `bun run knip:check` both exiting 0, with source/index unchanged. This is GREEN for those checks only. The earlier confirmed failure and repair lineage remain preserved. |
| Windows root verification | Failed/incomplete runs, runner index contamination, cancellation/termination uncertainty and remaining platform/tool failures remain unresolved in the final gate record. Partial pass counts cannot become a complete root-suite PASS. |
| Linux unchanged-base prerequisite sample | 59 cases passed across `test-hermetic-home.test.ts`, `script/agent-cleanup-hook.test.ts` and `script/agent-harness-wiring.test.ts` on base `23d3eb74f68ec6c23a23d24b0c310b1e5a9a516f`. This establishes representative prerequisites on that base, not candidate qualification or a full Linux/root-suite PASS. |

## Acceptance and review handoff

At this reconciliation, final Quality completion, independent General/Security Full, final finding triage and assembled AC01-AC11 acceptance remain pending. The completed scoped quality-finding triage and Knip repair do not stand in for that chain. Planning Full usage remains **1/2** and implementation Full **0/2**; failures and review budgets are retained.

Main records actual check completion, freezes the complete candidate and binds all independent reviewers to the same base/HEAD/patch. Triage precedes confirmed repairs; Delta applies only to real repairs and their direct regressions. Local qualification, publication and human merge/release decisions remain separate. Current operational evidence and decisions belong in the [Issue #2 evidence, review and acceptance ledger](https://github.com/Artifaktory/oh-my-openagent/issues/2), with redacted raw histories kept locally.

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
