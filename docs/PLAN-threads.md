# Plan: element threads

Feedback is scoped to the page element it's about. Each element gets a **thread** with its own persistent harness
session; markers on the page show each thread's state. A central conversation covers the page as a whole and routes
each utterance to a thread. Contracts: `shared/threads.ts`, the `thread*` messages in `shared/protocol.ts`,
`PageCmd` in `web/cursor/pageBridge.ts`, and the router / `HarnessThread` / `SolveInThread` types in
`server/adapters/types.ts`. Scope: the pipeline (`pipeline.ts`), the only approach since A and C were removed (2026-10-17).

## Decisions

| Topic | Decision |
|---|---|
| Who gets the full result when a thread finishes | Spoken in full if it's the **focused** thread (latest `lastInteractionAt`) or no other thread is running; otherwise a one-line reminder and the thread goes `pending` (drawn as done; the reminder is a notice, not a question that waits for a reply). Reminders that are ready together are batched into one line. Pending results are never read out on their own. |
| Follow-up to a running thread | Queued behind the current run (`followup`). A correction ("actually make it green") aborts and restarts the run with the combined request. |
| Concurrent edits to one file | Nothing blocks. Each run reports the files it edited. If two runs whose time windows overlap touched the same file, the run that finished later gets one short `reconcile` follow-up ("X was also changed by another task meanwhile: re-read it and check your change is intact"). There's no cost when runs don't overlap. |
| Live harness sessions | At most 10 (`MAX_LIVE_THREAD_SESSIONS`). The least recently used idle one is closed; its thread replays its history into a new session when needed. |
| Delete | Removes the thread: the run is stopped, the harness session closed, the thread and its marker removed. Edits stay in the code. The confirmation is drawn in the panel (no `window.confirm`) and says when the thread is still running. The central conversation keeps its one-line entries about the thread (the edits are still there). |
| Lifetime | Threads and the central conversation live in the server process: they survive page and sidebar reloads and are gone when the app closes. "New conversation" clears the central conversation and every thread (runs stopped). |
| Page identity | `normalizePageUrl`: the URL without its `#fragment`. `pricing.html#faq` = `pricing.html`; `?plan=pro` is a different page. Threads work across pages. |
| Threads on other pages | Listed in the sidebar, grouped by page (state, unread dot); clicking one navigates there and opens its panel. Their bubbles show in the sidebar. |
| Bubbles | From the thread's marker (sidebar for central lines and other pages). Each stays shown until the pointer leaves it or it's clicked, then shrinks into its marker; hovering the marker grows it back out, clicking the marker opens the thread panel. A new line of the thread replaces it. `needsReply` (reminders, questions back to the user) draws it with an amber border. |
| Conversation orb | A bigger marker (40 px) for the central conversation, on every page: fixed in the viewport, bottom center (25 px above the bottom) until dragged; the dragged spot is kept in the sidebar's settings as fractions of the viewport. Central lines and replies to turns that went to no thread bubble from it (and stay in the sidebar's conversation); it pulses (running) while such a turn or a background job is being worked on. Clicking it opens a panel with the conversation as the sidebar shows it. Pointing at it points at nothing. To be replaced by an SVG mascot. |
| Speaking floor | Speak only when nobody is speaking. Priority: the user (active turn, PTT, always-listen) > the current turn's reply > the focused thread's result > reminders. An interrupted reminder isn't replayed (the bouncing marker carries it). |

## Example

Red **Get started** and blue **Learn more** buttons; ◌ running, ● idle, ⦿ pending (drawn like idle), 💬 bubble from a
marker, 🗨 central.

```
[0:00] USER (on red)  "Make this bigger and round the corners more."   → NEW T1, ◌
       💬T1 "Sure, I'll make it bigger with rounder corners. I'll let you know."
[0:09] USER (on blue) "Why is this one blue and not the brand purple?" → NEW T2, ◌
[0:15] T2 done; focused → 💬T2 full answer, ●
[0:24] USER (on red)  "Also change the label to 'Start free'."         → T1 followup (queued); T1 focused
[0:30] USER (footer)  "Make the footer links a lighter grey."          → NEW T3, ◌; T3 focused
[0:47] T1 done; not focused, T3 running → 💬T1 "An earlier task on the red button finished. Want me to tell you about it?" ⦿
[0:52] USER "Does the hero image load lazily?"                         → central 🗨
[1:02] T3 done; focused → 💬T3 full result, ●
[1:10] USER "Tell me about the red button."                           → tell T1 → 💬T1 full result, ●
[1:25] click T1 marker → panel (history, files) → Delete → confirm → thread removed
```

## Architecture

**Server.** `server/threads/`: a process-level `ThreadStore` (threads + central conversation; resettable for tests),
a runner per thread (queue, abort/restart for corrections, reconcile), the notice policy (pure) and the speaking
floor. The Session sends `threads.snapshot` on connect and broadcasts `thread` / `thread.removed` / `thread.say`.
In B, after pointing is resolved the turn infers the anchor (`shared/anchor.ts`), passes the thread briefs to the
router and acts on `target` / `tell`. Quick questions still answer inline as the turn's reply, but they're recorded
in their element's thread (`decision.threadId` tells the client which marker the reply's bubble comes from).

**Harness.** `openHarnessThread` (`server/adapters/harnessThread.ts`) keeps one agent per thread across requests:
claude-code keeps its stream-json process open; codex keeps its app-server thread (not ephemeral); opencode keeps
its session; pi/omp send another rpc `prompt`; grok replays the transcript each time. Each result reports
`filesTouched`.

**Router.** The router is given the thread briefs and outputs, after `intent` / `estimate_seconds`: `target`
(`new` | a thread id | `central`), `relation` (`followup` | `correction`) and `tell`. The anchor match only breaks
ties ("the cursor is on T1's element"); what the user says wins.

**Page.** In the page preload's shadow root: markers at the top-right of their anchor element, re-resolved on
scroll, resize, DOM mutation and HMR (selector → role + text → last bounds; faded if not found). Also the
provisional marker at release, the thread panel (history, files, delete + confirm) and the bubbles. The sidebar
relays thread messages to the page (filtered by page URL) and shows the thread list and central bubbles.

## Milestones

1. **Server core + harness + router (B).** Store, runner, persistent sessions, router target, anchor inference.
2. **Markers and panel.** States and animations, re-anchoring, panel, delete, the sidebar list, survives reload.
3. **Floor, notices, bubbles.** Arbiter, notice policy, batching, bubble timers.
4. **Hardening.** LRU replay tests, an `ARCHITECTURE.md` §7
   rewrite.

Milestones 1–3 are built in parallel against the contracts above (one owner per file set); milestone 4 follows.
