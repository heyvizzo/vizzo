# Plan: native agent capabilities, context continuity, and debugging

Date: 2026-11-12

Status: implementation decisions approved by the user; this document is the handoff to the implementing agent. No product implementation was performed while writing it.

## Objective

Make Vizzo's solver retain the capabilities and working context of the user's normal coding harness, while adding Vizzo's voice, pointing, drawing, and conversation interface. Make the complete request path inspectable so quality problems can be traced to transcription, interpretation, context handling, capabilities, execution, or result presentation.

Support every existing solver harness: Claude Code, Codex, Grok, OpenCode, Pi, and OhMyPi. Preserve user-selected models and reasoning effort.

## Approved decisions

The user answered yes to all of the following recommendations:

1. Enable every available solver capability switch for existing installations as a one-time migration, as well as by default for new configurations. Keep switches individually configurable afterward. Keep the router and filler roles restricted to their jobs.
2. Replace the central conversation's arbitrary 2,000-character cutoff with complete earlier answers and an explicit overall context-budget strategy for long conversations.
3. Include native session resumption where supported, with clearly identified transcript replay as the fallback.
4. Capture full debug traces only while enabled, save them locally with bounded retention, and provide export and deletion controls. Traces must survive app restarts.
5. Make two narrow solver-prompt adjustments: describe live-page visibility according to available browser capabilities, and require appropriate verification for the requested change and available tools.

Also agreed in the preceding discussion:

- Preserve native solver instructions and append Vizzo's instructions through each harness's supported mechanism.
- Preserve the original user wording alongside the router's interpretation and captured context.
- Build on the existing debugging UI and Claude's completed global/project instructions feature.
- Keep the current spoken/detailed response format and user-controlled reasoning effort.

## Starting state and ownership

Claude finished its work, but that work is still present as tracked modifications and untracked files in the shared working tree. Do not assume a clean checkout or treat uncommitted files as disposable. In particular, preserve the new instruction settings, language support, speech installation work, and associated tests and documentation.

Before editing:

- Read applicable repository instructions and current versions of the files below. Line numbers from the conversation may have moved.
- Inspect `git status` and the existing diff; record the baseline without resetting, stashing, or committing unrelated work.
- Run relevant baseline checks so pre-existing failures can be distinguished from regressions.
- Verify installed harness versions and their current documented APIs/flags before choosing append, resume, or capability mechanisms. Record evidence and limitations in `docs/API-NOTES.md`.

This handoff does not request delegation or concurrent agents. It does not authorize publishing, pushing, or committing unrelated work.

## Relevant code and confirmed behavior

| Area | Files / behavior at handoff |
|---|---|
| Harness adapters | `server/adapters/harnesses.ts`, `claudeCli.ts`: Claude uses `--system-prompt`; Pi/OhMyPi also receive that flag; project-backed Codex uses `developerInstructions`; Grok with tools uses `--rules`; OpenCode receives a `system` field. Verify each mechanism's semantics. |
| Capability defaults | `shared/config.ts`: most toggles default OFF; Codex shell defaults ON. `cleanToggles` removes values equal to defaults. OhMyPi has a separate hardcoded `--no-lsp`. |
| Vizzo prompt composition | `server/adapters/claude.ts`: `roleSystem`, `projectNote`, `harnessPromptInfo`, `solverUserMessage`, `historyMessages`. |
| Saved instructions | `server/instructions.ts`, `electron/instructions.ts`, `shared/instructions.ts`, `web/settings/instructions.ts`: global and project instructions, project precedence, current-request precedence, automatic saving. |
| Native/live session handling | `server/adapters/harnessThread.ts`, `warmPool.ts`, `server/threads/runner.ts`, `shared/threads.ts`. |
| History cutoff | `server/conversation.ts`: `DETAIL_MAX_CHARS = 2000`; `trimDetail` slices the beginning of an answer and adds an ellipsis. `historyMessages(..., true)` applies it to prior detailed assistant answers for central solver replay. |
| Element replay | `server/threads/runner.ts`: `replayText` restores stored messages/results and edited-file names, omitting acknowledgments/reminders. It does not apply the central 2,000-character cutoff or restore the complete native tool history. |
| Trace emission | `server/orchestrators/trace.ts`, `shared/protocol.ts`, adapter prompt/response callbacks. |
| Trace UI | `web/chat/promptView.ts`, `web/chat/main.ts`, `web/chat/settings.ts`, `web/settings.html`, `web/settings/main.ts`. A Debugging details checkbox and prompt/response inspector already exist. |

### Session terminology

An element thread is the user-visible conversation. Its underlying harness session can have a shorter lifetime.

- **Live continuation:** send the next request to the same native harness conversation. It retains whatever messages and tool context the harness still holds, subject to native compaction.
- **Native resumption (to add):** reconnect to the previous native conversation using a supported session identifier/resume mechanism. Do not call a fresh session with a text transcript a native resumption.
- **Transcript replay:** create a fresh native conversation and prepend Vizzo's stored messages/results. Earlier intermediate tool observations may be absent.

Currently sessions can close because of eviction, crashes/exits, certain interruptions, model/provider changes, or changed saved instructions. The live-session target is 10; eviction selects idle sessions, and busy sessions can temporarily exceed the target. Grok currently runs a fresh agent per request. Claude uses `--no-session-persistence`; Pi/OhMyPi use `--no-session`.

The central cutoff affects each prior detailed assistant answer during serialization. It does not truncate the stored answer, current user request, current answer, or element-thread replay.

## Workstream 1: native instruction composition

Define and implement an explicit per-harness solver instruction-composition contract:

1. Preserve the native coding instructions and tool guidance.
2. Add Vizzo's solver instructions and capability-dependent project note.
3. Add the existing saved global/project instructions, preserving their precedence rules and Vizzo's required result format.

Use a native append flag, developer-instructions field, or verified equivalent. Do not copy a static snapshot of a harness's native prompt into Vizzo. Do not silently replace the native prompt when an append mechanism is unavailable; report the compatibility limitation and implement the closest verified additive path where possible.

Retain specialized router/filler prompting. Those roles do not need the full coding-agent identity or solver tools.

Expose the composition mode in traces. Separate the Vizzo base prompt, project note, and saved instruction scopes instead of labeling the entire combined string as only `solver.md`.

Native prompt content may be assembled internally and unavailable to Vizzo. Label it as preserved but not captured unless the adapter actually obtains it. The inspector must not claim to display an exact internal model request when it only observes the harness boundary.

## Workstream 2: solver capabilities and migration

- Make all supported solver switches ON by default and perform the approved one-time migration of existing solver choices to ON, including existing OFF choices. Preserve model, effort, speed, and unrelated settings.
- Store a migration version so a subsequent user choice to disable a capability is respected forever after that migration. Apply consistently to the desktop chat settings and server selection paths; check both packaged and development paths and environment overrides.
- Keep defaults role-aware. The shared toggle definitions and cleanup logic must not accidentally enable router/filler tools or strip intentional role-specific values.
- Audit restrictions beyond checkboxes: explicit tool allowlists, safe/pure modes, environment flags, instruction discovery, extension/plugin loading, MCP filtering, LSP, and session flags.
- Preserve normal harness capability availability without automatically installing tools, plugins, MCP servers, or dependencies. An ON switch may remove a Vizzo restriction while the underlying harness still disables or lacks a feature.
- Report requested state, emitted configuration, and observed tool availability separately. Use an unknown/unverified state when actual availability cannot be observed.

Do not remove Vizzo's task authorization boundaries merely to improve tool availability. Capability availability does not itself authorize the solver to publish, commit, or perform unrelated actions.

## Workstream 3: original request and history

### Original wording

Carry distinct fields for the original transcript/typed text, the app's annotated transcript if different, and the router's interpretation. Keep these through central turns, inline element tasks, background jobs, queued tasks, corrections/follow-ups, and drawing requests.

Send original wording and interpretation to the solver with clear labels. The original user request is authoritative; the router interpretation resolves references but must not silently replace constraints. Preserve language, selectors, drawing IDs, and their links. Background work must use the input/context snapshot from dispatch rather than whatever the page looks like later.

### Central history budget

Remove the per-answer `trimDetail` clipping from solver history construction. Send complete earlier answers while the overall input fits its budget.

Implement a documented overall context policy that accounts for fixed instructions, the current request, attachments, and space for the response. Prefer verified harness-native context management where it applies. Otherwise use a configurable budget informed by known model limits, with a conservative documented fallback when limits are unknown.

When older history must be compacted, preserve user constraints, decisions, unresolved work, affected files, and verification results. Keep recent turns and the current request intact. Retain the full original history in storage; record the exact summary or omission and its reason in the trace. Never silently slice every answer or silently overflow the context window. Define an explicit failure/fallback if compaction cannot be completed.

Do not silently broaden the router to the solver's entire tool history. Document its own context policy and expose exactly what it receives; preserving original wording does not require sending every tool result to the router.

## Workstream 4: native session resumption

Build a verified support matrix for all six harnesses: live continuation, native persistence/resume, interruption, instruction updates, and context-management behavior.

Extend adapter lifecycle contracts to distinguish releasing a live process from deleting the underlying conversation. Keep resumable identifiers and compatibility metadata scoped to the correct project, harness, and thread.

On reuse:

1. Continue the live session when compatible.
2. Otherwise resume the native session when supported and compatible.
3. Otherwise create a new session and replay Vizzo history, recording why native resumption was unavailable.

Compatibility must account for model/provider changes, project changes, and updated saved instructions. Ensure new instructions apply on the next request without interrupting an in-flight task. Where native resumption cannot replace obsolete instructions reliably, use an explicit fallback rather than claiming the update took effect.

Retain the existing resource cap initially. Avoid killing a shared server or another thread while suspending one session. Never resend an already executed user task as a new action during recovery. On Delete/New conversation, prevent an old native identifier from reviving a cleared thread.

This work includes native recovery of existing logical threads; it does not require redesigning the product to restore every visible conversation after an app restart. Durable debug traces are explicitly required across restarts. Document any native session artifacts and their cleanup separately from trace retention.

## Workstream 5: full-path debug tracing and UI

Extend the existing Debugging settings and inspector. Distinguish showing already captured details from enabling future full trace capture; a visibility-only checkbox is insufficient for the approved behavior.

Capture a correlated timeline:

`User input → Captured context → Router → Delegation → Solver session → Tools → Result → Speech`

Trace fields should include:

- Trace, turn, call, job, element-thread and native-session identifiers; timestamps and parent relationships.
- Transcription output and timing, detected/selected language, original typed input, and the annotated transcript.
- Pointing/click/highlight resolution, element details, drawing references, supplied images, and browser URL.
- Exact router inputs and Vizzo instructions, raw response, parsed decision, parsing errors/fallbacks, and a comparison of original and delegated wording. A text diff is evidence of edits, not proof of semantic correctness.
- Solver instruction layers and the exact outgoing message after replay, saved-instruction handling, and attachment additions.
- Requested and observed model/effort/capabilities where available, working directory, and launch configuration with credentials excluded.
- Live continuation/native resume/transcript replay, transition reason, history budget, compaction, and restored/omitted context.
- Tool calls and results exposed by the harness, files changed, checks run, errors, interruptions, and completion status.
- Raw assistant output, extracted `SPOKEN` line, detailed UI output, filler/acknowledgment messages, and text passed to TTS. Label generated progress filler as generated filler, not observed execution progress.

Capture at the final adapter boundary after all Vizzo transformations. Keep the structured constituent fields so users can inspect both assembly and the resulting payload. Never label a reconstructed preview as the captured payload.

Fix these known gaps:

- `web/chat/main.ts` currently drops prompt/response events whose `jobId` matches an element thread. Render them in that thread's trace instead.
- `solveInThread` currently emits its prompt preview before `harnessThread.ts` adds replay and attachment-order text. Capture the final dispatched input as well.

UI requirements:

- A View trace action on central turns and element/background results.
- A stage timeline and expandable exact input/output views.
- Side-by-side original and delegated request, with text differences.
- Distinct instruction layers and clear labels for unavailable native internals.
- Copy, export, delete one trace, and delete all traces.
- Access to locally saved traces after restarting the app.

### Storage and retention

Full capture is opt-in and records only work captured while enabled. Disabling it stops new full capture; previously saved traces remain available until deleted or expired. Mark traces started/stopped partway through a request as partial.

Use a versioned local format and bounded retention by both age and bytes. Suggested implementation defaults, adjustable if measured trace sizes warrant it: 7 days and 250 MiB, deleting the oldest completed traces first. Clearly show retention behavior in settings. Bound large tool output/attachment payloads and make any capture truncation visible; capture limits must never change the input actually sent to the solver.

Reuse existing image-payload redaction/attachment infrastructure where appropriate. Avoid persisting API credentials or authentication headers. Store input audio metadata/transcript by default; this plan does not require retaining raw microphone recordings. Preserve supplied image references/previews sufficiently to understand the request and document export behavior for attachments.

## Workstream 6: narrow prompt updates

- Replace the unconditional statement that the solver cannot see the live page with accurate guidance: captured context is provided, and live inspection depends on available browser tools. Do not imply a live browser is available merely because plugins are enabled.
- Keep read-back checking, but add appropriate verification: relevant checks/tests for behavioral changes and browser inspection when available and useful. Report checks actually performed and any verification limitation. Avoid mandatory broad test suites for trivial edits.

Retain the user's revised project assignment, multilingual and drawing guidance, concurrent-edit protections, authorization boundaries, saved instruction precedence, and spoken/detailed output format.

## Delivery sequence

1. Establish the baseline and verified harness support matrix; define composition, session, and trace contracts.
2. Add final-boundary tracing and correlation first so subsequent changes are inspectable.
3. Implement instruction composition, solver defaults, the one-time settings migration, and narrow prompt updates.
4. Preserve original wording and implement central context budgeting.
5. Implement native resumption and explicit replay fallback.
6. Complete trace persistence, retention, export/deletion, and the UI.
7. Validate representative workflows and update architecture/API/user documentation to match the final implementation.

## Acceptance and validation

Use meaningful behavioral tests with fake harnesses for deterministic lifecycle/error cases, plus bounded real harness checks for claims that mocks cannot establish.

- Native coding guidance remains present after Vizzo instructions are added; each harness has verified evidence or an explicit limitation.
- The one-time migration turns existing solver switches ON without changing model/effort; a subsequent OFF choice survives restarts. Router/filler settings remain restricted.
- A request such as “Make this wider only on desktop; keep mobile unchanged and keep the icon aligned” reaches the solver with every original constraint, even if the router rewrite omits one.
- An earlier central answer longer than 2,000 characters remains complete below the overall budget. Over-budget histories use the documented policy, retaining current constraints and showing compaction in the trace.
- A follow-up works through live continuation, eviction plus native resume, missing/invalid native session plus replay, interruption, changed instructions, and model/provider change. No task executes twice.
- Tests verify that relevant prior tool context survives native resumption and that replay fallback is labeled rather than presented as equivalent.
- Saved instruction changes apply on the next request, including after warm-pool reuse/resumption, without interrupting running work.
- Central, inline element, background, queued, corrected, and drawing requests all have correctly correlated traces containing final outgoing input.
- Debugging OFF stops full capture. Restart preserves captured traces. Retention, export, deletion, partial traces, large payloads, and credential redaction behave as documented.
- The UI is exercised with real Electron/browser interactions, including trace access from element threads and settings persistence.

Run `npm run typecheck`, the relevant adapter/thread/orchestrator/settings tests, and the full suite when integration is ready. Use existing smoke fixtures where applicable. Record baseline failures separately.

Finally compare a small fixed set of tasks through Vizzo and the native harness using the same model, effort, initial project snapshot, and requested outcome. Include a visual edit, a multi-file behavioral change, and a follow-up that depends on earlier investigation. Compare constraint adherence, actual edits, verification, continuity, latency, and usage; avoid treating faster completion or a nicer summary as proof of higher quality. Keep evaluation edits in disposable fixtures.

## Completion report expected from the implementing agent

- What changed and how to use the trace UI.
- The verified per-harness append/resume/capability matrix and any remaining limitations.
- The final context-budget and trace-retention policies.
- Settings migration behavior and validation results.
- Results of the bounded native-harness comparison, clearly separated from hypotheses.
- Files changed by this implementation, preserving the completed work already in the working tree.
