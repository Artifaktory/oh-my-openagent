# OMO-AP-001 delivery plan, version 1.0

Lineage: accepted PLAN-2; exact plan digest and source base are recorded in README.md. Sections 9 and 10 below retain the accepted handoff and verification contract verbatim. Runtime issues #2/#3 have not started.

## 9. Concrete implementation handoff

Issue #2, producer:
- Add agents/autopilot.ts and the normal builtin/name/schema/metadata/display/model integration in the actual existing factory/config surfaces.
- Implement separately scoped policy-manifest/snapshot and decision-protocol concerns under the OpenCode adapter, with corresponding adapter configuration schema changes and generated schema/docs; extend the native user-only protection seam for enrollment/mode/allowed roots without changing ordinary model precedence. Do not make a Core package depend on the adapter/SDK.
- Implement the instruction-source preflight/composition closure above at general-agent registration and per-invocation assembly; bind manifest-publication and complete instruction-set digests in the producer contract. Extend the synchronous delegation/result seam with an internal typed receipt while preserving existing public task strings and existing session reservation, fallback, shared prompt dispatch and cleanup behavior.
- Enforce canonical Autopilot identity, fresh synchronous invocations and ceilings; explicitly reject its background and task_id continuation paths, including resolved old-session agent aliases. Preserve other agents' modes.
- Prove native configuration precedence, supported aliases, unavailable settings, fallback identity, role discovery, rule A/B/revert, partial manifest failure, stale cached context and malformed/provenance-mismatched output. Return an accepted callable-agent revision and typed producer contract.

Issue #3, consumer:
- Wire a mandatory gate dependency through plugin/tool-registry-gated-tools.ts and tool-registry-factories.ts to tools/task/task-update.ts. Missing dependency in enabled mode must deny admission, including config-only test construction.
- Factor pure post-image calculation without changing disabled native semantics; use the existing task-store/lock/write APIs and validate the actual post-image.
- Implement a per-invocation state/receipt coordinator and evidence-provider enrollment, scoped to this one action. Apply host context, snapshot/CAS, deadline/cancellation and separate todo-projection result handling.
- Use the typed #2 receipt and verify the complete manifest/instruction-set/configuration tuple; never interpret generic result Markdown, metadata or task.owner as authority. No global stop-continuation/goal/boulder manipulation.
- Verify all managed completed post-image entry cases, disabled compatibility, unavailable guard, concurrency/metadata changes, wrong task/store/workspace/session/model/policy, cancellation/late output, partial effects and restart limits in real isolated OpenCode QA.

Dependencies: #1 reviewed contract -> #2 accepted callable producer -> #3 accepted guard integration. Shared config/delegation/registry surfaces are a serial integration conflict set until explicit ownership/version contracts permit concurrency. Do not run parallel writers merely because branches differ. Current runtime remains unchanged until those separately authorized deliveries.


## 10. Verification and review contract

Issue #1's actual checks concern source identity, document/packet structure, valid references, scope, coverage and independent semantic review. They do not prove executable Autopilot behavior. Source bytes, run packets, prompts, reports and checks remain in ignored local evidence; public docs carry redacted summaries and source references, not private policy transcripts.

Required future runtime groups:
- positive Sisyphus -> named Autopilot -> typed decision -> exact protected update;
- model/config/category/profile/alias and fixed-ceiling negative cases;
- published A -> B -> revert in one parent; A remains stable in flight; partial multi-file data and attempted old-child reuse rejected;
- all effective completed post-images, metadata-only changes, no-op, reopen/delete boundaries;
- stale/CAS contention, mutated arguments, cross-workspace/old-session/replayed/late decisions;
- enabled initialization failure, disabled compatibility, timeout/cancel and bounded retry;
- commit-before-projection failure and restart/uncertain-effects reconciliation;
- real harness hook/transport and store behavior using the repository opencode-qa isolation/evidence procedure. Mocks alone do not qualify integration or model judgment quality.

Use actual source-required Bun typecheck/build/tests and targeted suites for the runtime diff. Do not loosen checks or report unrun procedures as PASS. Record the actual isolated OpenCode binary/version, model/provider or local fixture provider, source revision and observed behavior. Provider-specific/model-quality claims require their own evidence; no such claim is made here.

For this planning-only docs patch, select source/reference/scope/packet checks and applicable existing Markdown/evidence audits locally. Explain non-applicability of runtime build/provider/harness claims; an inherited required check cannot be waived by silently calling it irrelevant. GitHub Actions are disabled on this fork under the operator's no-runner instruction; that state is not a green CI result or merge authorization.
