# OMO-AP-002 implemented contract

This describes the callable assessment contract for [Issue #2](https://github.com/Artifaktory/oh-my-openagent/issues/2), which owns final evidence, review and acceptance status. The [verification map](verification.md) identifies owner tests, native cases and qualification limits. [Operator setup and policy publication](../../reference/configuration.md#autopilot-opencode) define the editable boundary.

## Public named-task request

Call the existing `task` tool with `subagent_type: "autopilot"`, `run_in_background: false`, a normal description and this strict JSON string as `prompt`:

```json
{"protocol":"autopilot.assessment.v1","task":{"store":"tasks","id":"task1"},"subject":{"path":"evidence/subject.md"},"evidence":[{"id":"check","path":"evidence/check.json"}]}
```

Use the actual registered native alias when applicable. Do not include `task_id`, `category` or `command`. `load_skills`, if supplied, is an array of native names whose sources must be operator-enrolled as `caller_skill`. The assessment has no caller-provided model, gate request, verified flag, signature, approval, digest or host identity. Extra fields fail validation. It is limited to 16384 UTF-8 bytes, one task/subject and 1-30 uniquely named evidence references.

`task.store` identifies a directory under an enrolled task-store root; the host reads `<store>/<id>.json`. Task IDs allow letters, digits, underscore and hyphen, up to 128 characters. The strict native [TaskObject schema](../../../packages/omo-opencode/src/tools/task/types.ts) requires `id`, `subject`, `description`, `status` and `threadID`; `blocks` and `blockedBy` default to empty arrays. Optional native fields are `activeForm`, `owner`, `metadata`, `repoURL` and `parentID`. A deleted task is rejected. The host checks that the task's origin thread is the caller or an ancestor, within the same canonical workspace, through a bounded session ancestry lookup. Caller metadata cannot establish lineage.

Subject and evidence references must resolve within enrolled evidence roots. Their contents are bounded UTF-8 files, not executable instructions. The host captures task and subject as additional evidence IDs `_task` and `_subject`, computes exact file/canonical task digests and a prospective completed task image, and supplies fixed options: `complete` for that exact post-image, `rework` with category `required_evidence`, and `operator` to return to the operator. It performs no task write or todo projection.

## Public result and decision

The task tool returns one strict JSON string with `protocol: "autopilot.result.v1"`. No Markdown wrapper or continuation tail is appended: the [task-resume hook](../../../packages/omo-opencode/src/hooks/task-resume-info/hook.ts) recognizes this protocol and leaves it intact. Consumers parse the complete string; extracting a JSON prefix or repairing model output is not part of the contract. On validated model completion its fields are:

| Field | Meaning |
| --- | --- |
| `decision` | Validated `autopilot.model-decision.v1` object |
| `invocation_id`, `request_digest` | Host invocation and canonical request binding |
| `scope` | Captured host, task, subject, evidence identity/hash list and deadline |
| `provenance` | Child, final/prompt message, canonical/native agent, actual provider/model, observed reasoning, parameters digest and fallback attempt |
| `policy` | `revision`, `manifest_digest`, `policy_digest`, `instruction_digest`, `configuration_digest` |
| `effect` | Always `"not_attempted"` in this delivery |

The decision contains exactly `protocol`, `invocation_id`, `request_digest`, `outcome`, `reason_codes`, `evidence_ids`, `explanation`, and `option_id` only for `select_option`. Outcomes are `approve`, `rework`, `select_option` and `human_required`. Reasons are 1-16 bounded lowercase codes; evidence IDs must refer to captured evidence; explanation is 1-4096 characters. Decision JSON is bounded to 16384 bytes. An `approve` or completion option additionally requires same-workspace lineage and valid, unexpired enrolled evidence. It is an assessment of the captured proposed image, not permission to perform any effect.

A failed invocation instead returns this shape:

```json
{"protocol":"autopilot.result.v1","outcome":"human_required","error":"invalid_configuration","effect":"not_attempted"}
```

Other bounded errors identify invalid request/decision/manifest, unavailable or mismatched policy/evidence, unresolved lineage, forbidden tool/source, changed input, cancellation, expiry, unavailable runtime, unverified context or native result rejection. An old Autopilot `task_id` returns `child_reuse`, including task-ID-only calls; background mode returns `background_unsupported`. Combining the named Autopilot call with `category` or `command` returns `invalid_request`. Recursive calls from an Autopilot child return `tool_forbidden`. A successfully validated model decision may itself have outcome `human_required`; that differs from an invocation error.

The public [assessment parser](../../../packages/omo-opencode/src/features/autopilot/decision-validation.ts), [task interceptor](../../../packages/omo-opencode/src/tools/delegate-task/autopilot-task.ts) and [decision schema](../../../packages/omo-opencode/src/features/autopilot/protocol.ts) are the field authorities. Generic Markdown, reasoning-only output, stale messages, wrong-child/model results and transport success cannot substitute for validated final output.

## Internal producer and lifecycle

One `createAutopilotRuntime` instance is created by the plugin and passed through tool and plugin-interface construction. `runtime.invoke(payload, context, callerSkills?)` returns `{ ok: true, decision, receipt }` or `{ ok: false, error, outcome: "human_required" }`. Parent session, message, tool call, agent and abort context come from the native host. `runtime.isReceipt` recognizes only object identities issued by that runtime's private ledger. Serialized public metadata, copied receipts and receipts from another process/instance are not authority.

The host builds `autopilot.gate-request.v1`, including action `task_update.completed_revision`, captured task pre/post-image and subject/evidence identities, permitted options, policy/configuration tuple, total deadline, model chain and permission ceiling. Callers do not construct this object through the public task API. The current assessment computes only `{ id, status: "completed" }`; arbitrary completed-revision TaskUpdate interception and final storage admission belong to Issue #3.

The [producer](../../../packages/omo-opencode/src/features/autopilot/autopilot-runtime.ts) refreshes [native configuration](../../../packages/omo-opencode/src/features/autopilot/native-config.ts), captures the complete policy, resolves the registered subagent and invokes the existing synchronous task runner through the shared dispatch gate. Admission, model/provider capacity and cancellation are invocation-bound. It allows one primary and at most one captured native fallback, each with a fresh child and actual model accounting. No generic model suggestion may widen that captured chain.

The default child has no tools. Native settings may enable only `read`, `glob` and `grep`, further restricted by mandatory argument/path checks to enrolled evidence roots. Write/edit, bash/shell, delegation and unknown tools remain forbidden. Enrolled policy, prompt/append/category guidance and skills change the editable instructions; they cannot replace the fixed factory/decision contract, private ownership, deadline or tool ceiling.

Mandatory chat, parameter, system, message and tool boundaries own the child's instructions, request and ceilings. Completion requires the chat/system/messages/params observations and a completed final message matching the owned child, prompt and model. Missing observations fail as unverified context or rejected native output; optional hook absence cannot create a receipt. Retained native rule injection and transcript contents cannot become a replacement policy.

Reuse the parent for later assessments, including A/B/revert policy changes; never reuse the Autopilot child. Task-ID-only continuation also checks retained Autopilot identity. An in-flight call retains its captured behavioral rules/model; publication during capture may reject a mixed set. Authority changes are checked again before receipt issuance. Cancellation, expiry, parent deletion/error or runtime disposal invalidates pending work, and late output is not approval. Restart does not reconstruct private ownership from old transcripts or replay a decision.

The [QA readiness and recovery procedure](verification.md#recovery-groups-and-qa-readiness) explains how the native driver establishes startup and ordinary-continuation prerequisites. Those controls qualify the test setup; they do not widen this assessment contract or supply a passing host result.

For direct old-child rejection, the [native denial QA procedure](verification.md#strict-native-direct-denial-proof) correlates a masked HTTP error with the actual native error field and checks child lineage, message identities and provider activity before and after the request. This is QA observation of the existing guard. It adds no public error protocol, receipt authority, retry, tool permission or task effect.

The driver uses [independent QA fixtures](verification.md#isolated-qa-roots) between otherwise independent group segments. This test setup preserves the existing root capacity and each segment's parent/task identity; it does not change the runtime assessment or permission contract.

## Evidence trust and recovery

Operator enrollment permits the host to read particular roots. The host supplies source identities, bytes, hashes and capture/deadline times; caller-supplied attestations are not inputs. `enrolled` describes that capture boundary, not independent verification that an evidence file's claims are true, current for the business task, or approved by a human. Evidence bodies and task metadata remain untrusted data. Exact hashes establish identity, not factual correctness. The model's interpretation still needs real-provider qualification.

Keep secrets out of every enrolled file. Record redacted provenance/digests and errors instead of sensitive policy, evidence, environment or authentication content. Repair invalid configuration/publication before a new assessment; do not turn a failed or missing result into an approval. Preserve prior evidence and use a new invocation after restart. TaskUpdate interception, compare-and-swap (CAS), mandatory completion gating, signing and task/todo effects are outside Issue #2. Issue #3 must establish its own storage locking, freshness rechecks, final admission and separate effect reporting. This public protocol continues to report `effect: "not_attempted"`.
