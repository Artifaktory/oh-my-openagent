# OMO-AP-001 technical design, version 1.0

Lineage: accepted PLAN-2, with its exact SHA-256 and immutable source base recorded in README.md. Sections 1 through 8 below retain the accepted technical content verbatim.

Status: planning contract only. Runtime implementation and qualification remain future work under issues #2/#3; all new keys/settings are proposed. Planning acceptance is not human approval.

## 1. Objective and bounded first delivery

Sisyphus remains the main coordinator. An optional built-in Autopilot specialist evaluates a structured gate request and evidence; runtime code validates its answer before a particular protected operation can proceed. Operator-editable behavioral rules can evolve without changing runtime code. Model/provider/reasoning/fallback configuration uses the native agent configuration path.

The first gate is **admission of a completed revision through the native task_update tool**. In enabled mode it covers every managed update whose computed post-image is completed and differs from its pre-image. Thus a caller cannot avoid review by omitting status while changing an already-completed task's description or metadata. A truly identical already-completed revision is a no-op, not a new approval. Reopening to pending/in_progress or deleting a task does not constitute completion; existing project approval requirements still apply.

This gate changes task metadata only. It does not approve Git merges, releases, credential changes, production actions, signatures, withdrawals or operating-system permissions. A completed task record is never a human approval for the work described by its subject. This delivery does not discover natural-language gates or protect arbitrary filesystem/shell mutations. It assumes a trusted host and runtime; it is not an OS sandbox against a compromised coordinator with arbitrary host access.

Issue #1 produces this reviewed contract, a feasible implementation plan and verification handoff. Issue #2 implements the callable specialist and invocation/policy support. Issue #3 implements the one protected task-store operation. Neither runtime issue starts automatically.


## 2. Verified source facts and selected qualification target

Source baseline: Artifaktory/oh-my-openagent commit 82842459ba4bdb0568c31511661f222ad06c928d, root package 5.1.49. Both root devDependencies and packages/omo-opencode/package.json pin @opencode-ai/plugin and @opencode-ai/sdk to 1.18.31. The root AGENTS release header and some ROADMAP configuration prose are older than these source facts.

Selected initial runtime qualification target for #2/#3: **OpenCode 1.19.4 on Windows x64**, with the pinned 1.18.31 SDK/plugin and a build of the accepted fork revision. The installed npm wrapper metadata is 1.19.4, and the upstream v1.19.4 release exists. An attempted global version-only command failed with EEXIST in the existing user configuration path; it was not repaired or treated as executable-version proof. Actual isolated binary/version and compatibility verification remains a mandatory runtime-start input. Local Node 24.17.0 and Bun 1.4.4 match the source's Node 24/Bun 1.4.4 requirements. Other host versions/platforms are not qualified by this plan.

| ID | Actual source surface | Relevant fact |
| --- | --- | --- |
| S1 | packages/omo-opencode/src/tools/task/task-update.ts | Input parsing and task ID validation precede task-list locking; applyTaskUpdate reads, mutates, validates and atomically writes the task; todo synchronization follows lock release. |
| S2 | packages/omo-opencode/src/tools/task/types.ts | Completed is a typed status; TaskObjectSchema is strict; metadata is caller-editable arbitrary data and is not approval authority. task_create initializes pending and records threadID from host context. |
| S3 | packages/omo-opencode/src/features/claude-tasks/storage.ts | getTaskDir uses configured storage_path or a resolved task-list ID; the default list ID derives from process.cwd basename. Atomic file replacement is separate from locking; stale-lock reclamation is not an exactly-once guarantee. |
| S4 | packages/omo-opencode/src/plugin/tool-registry-gated-tools.ts; shared/task-system-enabled.ts | task_update exists only when experimental.task_system is enabled; the factory receives plugin configuration and context. |
| S5 | tools/task/todo-sync.ts | Todo projection has separate API effects and catches failures; a void return does not prove successful synchronization. |
| S6 | agents/builtin-agents.ts; agents/builtin-agents/general-agents.ts; config/schema/agent-names.ts | A builtin requires factory/name/schema/metadata integration; a prompt file alone is insufficient. |
| S7 | config/schema/agent-overrides.ts; agents/builtin-agents/agent-overrides.ts; plugin-config/omo-config-chain.ts; config/validate.ts | Native model/category/profile/override keys exist; reasoning is canonical and legacy aliases are migrated. file:// prompts are materialized during config assembly. |
| S8 | tools/delegate-task/tools.ts; subagent-model-resolution.ts; sync-task.ts; sync-task-runner.ts; sync-result-fetcher.ts; sync-continuation.ts | Named delegation creates children and returns text. Fresh calls refresh model configuration, continuations reuse prior state. Current results are string-oriented, may include reasoning fallback and must not be accepted as a typed gate decision. |
| S9 | shared/prompt-async-gate.ts; packages/utils/src/prompt-async-gate.ts | Internal prompt writes must pass through the established dispatch gate. queued/dispatched is not model completion or workflow approval. |
| S10 | hooks/rules-injector/injection-processor.ts, cache.ts and transcript-hydration.ts | Native rule injection deduplicates session/file paths and does not establish a fresh invocation-scoped policy snapshot. |
| S11 | shared/agent-tool-restrictions.ts; plugin-handlers/tool-config-handler.ts; config/schema/internal/permission.ts | Builtin names have explicit restrictions; tools and permission are native settings, including external_directory. A new name does not inherit a safe ceiling automatically. |
| S12 | shared/safe-create-hook.ts; plugin/tool-execute-before.ts; hooks/ulw-execute/ulw-execute-hook.ts | Optional hook initialization may yield null; before-tool control exists, but task-store enforcement must not depend on a skippable optional hook. ulw-execute prefers Atlas when registered. |
| S13 | hooks/goal/tools.ts | update_goal can replace an objective and target sessions, not just complete a simple task. |
| S14 | upstream anomalyco/opencode packages/plugin/src/tool.ts at v1.18.31 and v1.19.4 | ToolContext includes host-supplied sessionID, messageID, agent, directory, worktree and abort. Those fields, not task metadata, identify the calling context. |

Paths without another prefix in S5-S13 are below packages/omo-opencode/src/. Source text and exact identities are retained in the local handoff, not copied as private governance transcripts into public documentation.


## 3. Architecture decisions

ADR-01: choose native task completion, rather than goal completion. It already has a typed status and a central write boundary. Goal completion adds objective replacement, session targeting and controller/TUI routes. A prompt-only reviewer cannot enforce the selected store operation.

ADR-02: enforce at the TaskUpdate execution/storage boundary, not solely in tool.execute.before. Every native TaskUpdate execution path reaches the same mandatory guard for the effective completed post-image. An enabled-but-unavailable guard returns a structured non-admission result. A missing optional hook never turns protection off. Other native task operations and permitted independent work are not globally stopped.

ADR-03: the initial specialist uses a fresh synchronous child for every decision, within the existing named-delegation lifecycle. Persistent parent sessions remain supported. Autopilot background requests and continuation of an old Autopilot child are explicitly unsupported in v1 and fail with a typed error; detection also covers task_id-only continuation after resolving the old child's actual canonical agent. This limitation is confined to Autopilot; existing agent background/resume behavior is preserved. Freshness tests include attempted reuse and a new decision in the same parent.

ADR-04: add a typed internal result receipt around the existing synchronous delegation service. Preserve the ordinary task tool's string return for existing consumers. Gate code must obtain child/message/agent/model provenance from runtime-owned state, not parse a session ID or approval from caller text or a generic Markdown completion wrapper. Existing dispatch/limits/cleanup and the shared prompt gate remain in use.

ADR-05: use explicitly selected, versioned policy files with a manifest for atomic publication of a multi-file set. Rule changes require editing/publishing that data set, not rebuilding the plugin. There is no watcher, automatic home-directory discovery or ingestion of arbitrary task documents as policy.

ADR-06: task metadata and evidence bodies are untrusted data. Required source identity, request binding, action scope, permissions and protocol checks are runtime obligations. Behavioral interpretation remains a model judgment with recorded limits; hashes establish identity, not factual truth or human authorization.


## 4. Request, decision and receipt contracts

All wire objects are versioned JSON, bounded in size and validated before use. They contain no executable callbacks, shell commands to run, credentials or caller-created privilege grants.

GateRequest v1 includes:
- host-created invocation_id, parent/tool-call identity, deadline and action kind task_update.completed_revision;
- canonical host workspace/worktree identity, caller session/agent, resolved task-store identity and task ID;
- task origin thread and validated same-workspace/session lineage; unresolved or cross-workspace origin is human_required in v1, not silently trusted through owner, repoURL or caller flags;
- exact pre-image revision/digest, normalized immutable update arguments and computed post-image digest;
- subject snapshot identity and evidence references with source, captured bytes/digest, freshness and trust disposition;
- allowed option IDs with fixed runtime meanings, policy-set version/digest and effective native Autopilot configuration identity;
- allowed model/fallback entries, actual dispatch choice and applicable immutable permission ceiling.

A canonical request digest covers those fields. Bind the resolved task store and actual host context once; do not recompute a different process.cwd-based target after model execution.

ModelDecision v1 has protocol, invocation_id, request_digest, outcome (approve, rework, select_option or human_required), optional option_id, bounded reason codes, referenced evidence IDs and a bounded explanation. Strict validation rejects malformed/extra authority fields, mismatched references, missing output and expired/cancelled requests. Reasons are data; they are never executed. A model-supplied human signature, trusted flag or caller-created approval record has no effect.

Allowed options are supplied by runtime for this one gate: complete the exact post-image, request a named rework category, or return to the operator. select_option can mutate only if it selects the same explicitly permitted completion action and all approve checks succeed; other options do not write a completed task.

A runtime-owned DecisionReceipt records the validated decision, actual child/message identity, actual model/reasoning/fallback used, subject/action/policy/configuration digests, times and effect state. Only the internal runner's result can create this receipt; TaskUpdate accepts no external decision token. Do not store an authoritative approval in caller-editable TaskObject.metadata. An opaque informational reference there would not become authority.

The effect outcome separates task_store_commit (not_attempted/committed/unknown) from todo_projection (not_attempted/confirmed/unknown_or_failed). Existing todo-sync's void return cannot establish confirmed. The implementation must expose an internal projection result while preserving other callers' public behavior, or report unknown conservatively. No total-success claim is made from the existing swallowed-error path.


## 5. Decision-to-effect sequence and concurrency

1. Validate native TaskUpdate input and task ID. Derive caller context from ToolContext; resolve and capture the native task-store target. No caller field establishes workspace, actor or capability.
2. Capture the current task and relevant task-list data under the native short lock. Factor the existing mutation logic into a pure, tested post-image operation shared by guarded and legacy paths; preserve its null-delete and additive dependency semantics.
3. If the operation is not within this gate, follow its permitted normal path. If the computed completed post-image equals the pre-image, return an explicit already-completed/no-new-approval result without claiming a fresh review or replaying todo effects.
4. Release the task lock before collecting bounded evidence or awaiting any model. Capture an immutable policy/configuration/evidence/request snapshot. Required evidence with unestablished authority/freshness cannot become approval; return human_required or the specified non-admission error.
5. Invoke a fresh Autopilot child via the constrained existing named execution service. Deny recursive delegation and gate calls from the decision child. Require a completed response with strict final text/provenance; queued, dispatched, reasoning-only or unrelated prior text is not a decision.
6. Validate decision, scope, source identities, deadline and cancellation. Rework, human_required and non-completion choices leave task storage unchanged.
7. Reacquire the same native task-list lock. Re-read the task and compare the pre-image digest, target, applicable evidence/subject revisions and fixed current capability/mode checks. A changed task or required subject/evidence invalidates admission. Clone/freeze normalized arguments so later mutation cannot change the approved post-image.
8. Commit exactly the validated computed revision through writeJsonAtomic while holding the lock; release it promptly. The final synchronous admission fence checks cancellation/deadline and current operator enrollment/host ceilings immediately before the atomic task write. A revocation/disable invalidates pending admission, while a mere behavioral-policy/model revision follows the declared in-flight snapshot rule. Cancellation after that fence cannot undo an already committed effect; report committed or uncertain and reconcile instead of claiming zero effects. A policy file change alone does not replace the in-flight policy snapshot; subsequent invocations load the new version. Explicit disable/cancellation invalidates pending automatic admission.
9. Perform and report todo projection separately. Never rerun the task write merely to repair projection. If effect attribution is uncertain, return unknown and require reconciliation.

All writes through the managed TaskUpdate API that result in a changed completed revision are covered, including status omitted and metadata-only updates to an already-completed task. task_create produces pending. team_task_update, goal tools, direct file writes, Todo API mutations and other harnesses are separate mechanisms outside this first gate; none may be described as covered.

Storage locking, atomic replacement and an in-process decision ledger do not establish cross-process/crash exactly-once behavior. v1 never auto-replays an old decision on restart. Re-read persisted task state and correlate retained receipts; if attribution or a prior effect cannot be established, require explicit reconciliation. A new request gets a new invocation and fresh review. Native stale-lock reclamation is retained and tested; a slow model never holds that lock.


## 6. Native agent configuration and fixed ceilings

Register canonical autopilot through the ordinary builtin factory, names/types/schema, metadata/display-name and model-resolution paths. It is a subagent, not a second primary coordinator. Existing user/project/profile/category precedence and migration govern agents.autopilot model/models/category, reasoning and supported legacy aliases, declared fallbacks, tools and permission settings. Do not copy an obsolete configuration filename from ROADMAP or invent a second model selector.

Model choice is not prescribed by the feature. The operator's GPT-6-Astra/max choice in this development run applies to working sessions, not to the future Autopilot default.

Native precedence is reused rather than reimplemented: loadOmoOpenCodeConfigChain builds base views across native layers, then [opencode] views, selected-profile base views, selected-profile [opencode] views and the resolved model overlay, in that order. validatePluginConfig merges/prunes these and materializes an agent's models list; when present, its primary entry and remaining fallbacks replace the corresponding standalone chain fields. Agent assembly applies category properties to factory defaults, then direct agent overrides; canonical reasoning supersedes supported legacy aliases within that native migration. Tests must demonstrate those actual results, including models-list/category interactions, not assume every global setting wins over project settings.

New policy enrollment is separate from model precedence. Current protectUserFields only protects existing MCP/browser fields; it does not already protect Autopilot authority. The implementation must extend that native protection seam for proposed user-only [opencode].autopilot authority/mode fields obtained from the existing protectedUserView (including its selected user profile). Operator enrollment binds canonical workspace and allowed task-store/policy roots to this metadata-only action. Project views may select only permitted data or restrict/disable an enrollment; they cannot create one, broaden its roots, activate a user-disabled mode or grant human authority. Model/reasoning configuration continues through normal native precedence and is not moved into this user-only authority block. Invalid required Autopilot fields or an explicitly invalid model setting must block this gate rather than disappear into a broader default after native pruning.

Native registration/model lifecycle and policy reload are distinct. New guarded invocations resolve effective native configuration through the existing loader/normalizer. Apply the effective prompt/prompt_append and configured skills through the native composition semantics only after the authorized, exact-byte instruction snapshot described below has been captured; generic cached SDK prompt/skill materialization is not an authority or refresh mechanism. Unknown, disabled or unavailable required configuration fails the request. Actual fallback use is permitted only within the captured native chain and bounded gate budget, with actual model/effort in the receipt. Configuration refresh is never a permission to silently use Sisyphus-Junior.

The Autopilot ceiling denies write/edit, shell/interactive execution, task/call_omo_agent/team delegation and unknown mutating tools. v1 defaults to no tools because its captured evidence is supplied as data; supported explicitly selected read/search tools may be enabled only within the fixed allowlist and host permissions. Native configuration can restrict that set, not lift it. Apply ceilings after overrides and at dispatch; deny old Autopilot child continuation rather than inheriting stale tools. This does not claim OS isolation for the trusted host.

Keep Sisyphus primary in the supported configuration. Enabling this gate does not invoke ulw-execute or switch to Atlas. If Atlas or another permitted parent uses the same native TaskUpdate tool, the store guard still applies; it does not create a different agent-specific bypass.


### Native instruction-source closure (SEC-R1-001)

This clarifies the existing operator-selected-source boundary; it adds no instruction channel, model selector or authority. The supported native prompt, prompt_append, category-append and configured-agent-skill channels remain available, but their content cannot enter Autopilot merely because a project override or generic helper can load it.

Operator enrollment selects permitted native channels and their source identities. The policy manifest binds each selected resolved instruction payload by expected SHA-256, channel, native configuration origin/field (for inline text) or canonical permitted source path (for files/skills), and order. A project may supply matching enrolled content, not authorize a new channel/source. No native instruction overrides are enrolled by default. A populated but unenrolled channel, changed bytes without the corresponding publication, an unknown/removed source or a missing/unreadable file returns a typed non-admission error; it is not silently ignored, cached or converted into a generic warning-string prompt.

| Instruction input | Admission and composition rule |
| --- | --- |
| Builtin Autopilot factory/protocol | Fixed plugin-owned instructions identified by plugin revision and exact rendered bytes; never replaced as an authority grant by editable content. Structural protocol/permissions remain runtime checks. |
| Native category prompt_append | Explicitly enrolled and hash-bound if present. Keep the native category-before-direct-override composition semantics; category model/reasoning resolution remains unchanged. |
| Native direct prompt / prompt_append | Explicitly enrolled and hash-bound inline text or permitted file bytes. Native prompt replacement/append semantics still compose the editable portion; they cannot remove runtime validation or the final authoritative manifest layer. |
| Configured native agent skills | Enroll each resolved skill source and exact expanded instruction payload, including native ordering and supported arguments. Use that captured text in the native prepend position, not a later cache lookup. References inside a skill do not authorize additional policy reads. |
| Manifest-listed behavioral rules | The ordered published rules form the final authoritative behavioral layer over the composed editable native portion. A conflict with a fixed runtime boundary is rejected, never elevated by later text. |
| Caller task text, returned evidence and unenrolled ambient documents | Data, not policy authority. They cannot add instruction sources or supply a previously cached policy layer. Caller-supplied load_skills cannot add authoritative content outside this same enrollment. |

The instruction-set digest covers the ordered exact rendered factory/protocol bytes, every admitted native payload and the manifest rule bytes, plus their source identities and composition version. Keep the manifest-publication digest separately. GateRequest and DecisionReceipt bind both identities and the effective native configuration digest; #3 validates this complete tuple. A manifest label alone never identifies the full effective instructions.

Capture these inputs as one transaction: resolve the native configuration view, check raw Autopilot instruction references against enrollment before reading them, read/validate all selected payloads with the manifest rules, re-read the manifest and confirm the resolved configuration/source identities. Reject concurrent/mixed changes rather than combining a cached prompt with fresh rules. Retain immutable captured bytes for in-flight A; a next invocation loads the published B. Every instruction-source edit/revert uses the same manifest-last publication workflow. Native model/fallback settings retain their ordinary independent configuration lifecycle.

Implementation seam: general-agents.ts currently applies overrides then resolves skills; agent-overrides.ts and agent-skill-resolution.ts can materialize file/skill content, while resolve-file-uri.ts can return warnings. Autopilot registration must avoid eagerly materializing those mutable channels through the generic startup path. Its per-invocation builder preflights raw references and supplies already captured text to the native composition helpers (or a small snapshot-aware variant preserving their order); it must not let those helpers independently re-read files or silently use warning strings. Keep ordinary agents unchanged. Reconcile OmO rule-injector/transcript enrichment at the Autopilot boundary: any content intended as authoritative instructions must be part of this selected snapshot; unenrolled rule/task documents remain data and cannot be injected as a hidden authoritative layer. Fresh children do not excuse an unbound configured skill or ambient cache.

Future synthetic regression cases for #2 and #3: hold manifest A fixed and attempt each unenrolled native prompt/append/category/skill channel; expect non-admission before model dispatch. Publish an enrolled payload A -> B -> revert; the next call observes the changed instruction-set digest, an in-flight A remains stable, and a missing file/changed un-published payload fails closed. Exercise startup assembly and invocation separately to prove no earlier generic file/skill read bypasses the preflight. Existing model/category resolution tests remain required and distinct.


## 7. Policy publication and evidence trust

Proposed new runtime settings are a future design, not accepted keys in the current build: an Autopilot mode, an explicit policy-manifest reference and bounded request/attempt limits. They belong to the existing configuration chain with schema/docs in #2/#3; no parallel model/provider keys are introduced.

The manifest names an ordered, bounded set of UTF-8 rule files with expected SHA-256 digests, format version and an opaque revision label. Paths must be explicitly selected operator-authoritative non-secret sources, checked against allowed roots before reading; reject remote includes, credential files, path traversal and unsupported types. Ordinary source files, task descriptions and returned evidence never add policy authority. The operator/root policy controls allowed source selection and immutable runtime ceilings; less-trusted project inputs cannot expand that authority.

Per invocation, read a manifest, read/validate every listed file, then re-read the manifest and confirm identity. Keep the exact file bytes/order and computed aggregate digest in one snapshot. If files are partially changed or the manifest moved, fail closed; do not combine cached old text with new text or silently fall back to broader rules. A content digest, not just mtime/size, identifies an edit.

Editing instructions: write the changed rule set and update its manifest digests/revision, then atomically publish the manifest last. An unpublished file-only edit yields a policy-mismatch error at the next gate, not silent reuse of the old policy. This publication step is data editing, not a code rebuild or session restart. Revert by publishing a validated prior content set with a newly recorded publication identity. A running request retains A; the next invocation after published B uses B. Incomplete/missing/removed/conflicting data has an explicit error, no approval and no unbounded automatic retries.


### Concrete behavior-only change (PG-R1-01)

Illustrative rule A: for this task-completion request, accept one fresh, successful targeted-check artifact covering the changed subject. Rule B: require both that targeted-check artifact and a fresh successful regression-check artifact. These are behavioral review criteria within the already permitted metadata-completion action.

Hold the request's subject/action and supplied evidence content constant: the operator-enrolled evidence provider supplies only the valid targeted-check artifact; all fixed structural, source, authority, freshness and permission checks succeed. Under A, the expected model outcome is approve. After publishing B's rule bytes and updated manifest digests/revision, the next gate invocation in the same parent has a new invocation/request digest and is expected to return rework with a missing-regression-evidence reason, leaving the task unchanged. This is a planned scenario and expected judgment, not an executed result or a claim that every model will obey it.

For an in-flight A request, publishing B does not replace captured A. Revert by republishing A's validated content with a newly recorded publication identity; a subsequent otherwise equivalent request is expected to approve again. Change only the selected policy data and publication metadata: no runtime-code edit, rebuild or session restart. Model selection, tools, human-only exceptions, request/result validation and the fixed action remain unchanged. A file-only edit without publishing matching manifest digests fails policy validation instead of exercising B.

Trust requires more than a hash. Evidence is obtained by a runtime-owned provider, not by believing a caller's trusted/pass flags. Its enrollment and source authority come from operator-controlled configuration; unestablished provenance is human_required. For the initial local implementation, operator-authorized artifact snapshots are admissible only under that declared host trust assumption, with subject/digest/freshness checked. They are not cryptographic attestations that tests ran. A future trusted command collector would need its own producer/consumer contract; it is not silently assumed to exist in this source.

The model may judge content only within those limits. Prompt injection in evidence cannot create permissions, select new authoritative files, forge a host receipt or authorize another action kind. Secrets are excluded from policy/evidence; do not read authentication files, dump environments or log full sensitive prompt contents.


## 8. Failure and lifecycle table

| Condition | Required outcome |
| --- | --- |
| Explicit mode off | Native normal path; no Autopilot approval claim and no bypass of pre-existing project controls. |
| Mode on, task system/tool unavailable | Advertise unavailable capability; no false active-protection claim. Other independent tools/work may continue. |
| Missing/failed guard initialization | Keep the protected operation registered but non-admitting; no optional-hook/null bypass. |
| Missing/invalid policy, invalid model/config, missing authority | No completion write; bounded structured error or human_required, with precise reason. |
| Rework or non-completion option | Task unchanged; return bounded advice to Sisyphus, which retains orchestration responsibility. |
| Timeout/cancel/disable before final admission fence | Invalidate pending invocation and child result; no task write; late completion is discarded. Cancellation after admission may observe a committed/uncertain effect and must reconcile, not replay. |
| Task/subject/evidence changed during model call | Reject stale decision; no blind write or automatic unbounded rerun. |
| Valid completion under matching snapshots | One guarded native task revision write; report projection independently. |
| Crash/restart or uncertain prior effect | No automatic approval/side-effect replay; reconcile actual persisted state and require a new request or human intervention when uncertain. |

Default proposal: one primary model request, at most one declared native fallback, a 120-second total gate deadline and zero automatic gate re-evaluations after stale state. These are proposed bounded settings, not source behavior. Operator limits may tighten them; broader limits need validation within the supported cap. Model wait, task-lock wait and retry budgets remain separate and finite.
