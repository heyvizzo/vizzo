# Vizzo interruption behavior

Starting a new recording cancels the unfinished foreground turn before the next request's words or element are known. This also cancels solver work still owned by that turn. A different element does not protect that work. Work already handed off to a background thread or job survives a new recording.

This explains the two questions about the payout and the Live label on November 16, 2026. The application supports parallel background work, but these new questions were both running in the foreground when interrupted.

## Evidence from the two requests

Times below are Europe/Bucharest local time. The saved trace uses UTC, two hours earlier.

| Request | Solver started | Solver stopped | Outcome |
| --- | --- | --- | --- |
| Why is the payout unavailable? | 20:22:22.696 | 20:22:29.158 | Error: `The thread's request was stopped`, after 6.463 seconds. |
| What does Live mean, and was the bet placed while the matches were live? | 20:22:41.666 | 20:22:56.273 | The same error, after 14.608 seconds, immediately before the payout retry was dispatched. |

Sources: [payout request and error](/Users/j/.config/vizzo/traces/2026-11-16.jsonl:252), [Live request and error](/Users/j/.config/vizzo/traces/2026-11-16.jsonl:260), and [payout retry](/Users/j/.config/vizzo/traces/2026-11-16.jsonl:267).

Both router decisions estimated 15 seconds and selected a new element thread. The contemporaneous settings use a 20-second long-task threshold. Neither solver reached the automatic handoff at 25 seconds after solver dispatch. The next recording at approximately 20:22:29 produced no transcript, but had already cancelled the payout request. A later recording supplied the Live question.

The fast model, Cerebras Qwen through OhMyPi, produced the acknowledgement and progress lines. Codex running `gpt-6.1-sol` performed the actual solver requests. The payout retry continued its saved live harness session and completed at 20:23:39.222. Stopping the request therefore did not delete the thread or its harness session.

## When interruption cancels work

| Action or state | Current behavior |
| --- | --- |
| Start talking with the talk key or button while a foreground turn is unfinished | Cancel that turn immediately and clear playback, even while it is thinking and even if the next element differs. |
| Always listen detects a new utterance | Uses the same cancellation path. While a reply is in flight, the voice gate uses a 300 ms attack before opening. |
| Start dictating into an open comment or message form | Also cancels the foreground turn before transcription. |
| Talk while a background job or detached thread run is working | Stop its current spoken notice, if any; its solver continues. |
| Send an ordinary follow-up to a running background thread | Queue it behind that thread's current run. Other threads can work concurrently. |
| Route a correction to a running thread | Abort its current request and run the corrected request first, with the original request included as context. |
| Stop or Esc during foreground work | Cancel the foreground turn and silence playback. Background tasks have separate stop controls; the three-Esc flow asks to stop a task. |

Typed comments have an additional hold policy: comments wait while the current turn is still routing, answering silently, or delivering a background acknowledgement. That policy is not applied when starting a recording or dictation.

## Key components and why the behavior occurs

- [web/chat/main.ts](/Users/j/Sites/vizzo/web/chat/main.ts:1493): `press()` calls `cancelTurn(prev, "interrupt")` before creating the recording or collecting its page context. `startDictation()` follows the same policy. This gives the user immediate control of the speaking floor, but couples taking the microphone to cancelling work.
- [server/session.ts](/Users/j/Sites/vizzo/server/session.ts:214): `turn.cancel` clears the active turn and cancels its handlers. `startTurn()` also cancels an existing turn, enforcing one foreground turn per connection. Element routing happens later.
- [server/orchestrators/pipeline.ts](/Users/j/Sites/vizzo/server/orchestrators/pipeline.ts:280): new short requests are foreground work; existing-thread follow-ups and longer requests run in the background. Foreground cleanup calls `cancelRun()` unless the solver has already finished or been handed off. Automatic handoff uses the configured threshold plus five seconds and is suppressed once the solver's spoken answer begins.
- [server/threads/runner.ts](/Users/j/Sites/vizzo/server/threads/runner.ts:86): each thread has its own queue and session. Corrections abort and restart, ordinary follow-ups queue, and explicit task stops abort work and drop queued follow-ups.
- [server/threads/floor.ts](/Users/j/Sites/vizzo/server/threads/floor.ts:101): starting a turn cuts thread speech independently of its solver. This already provides separate speech interruption for detached thread work.

The design change needed for the described interaction is to keep element solver work alive when a new recording takes the speaking floor, then use the routed destination and relation to decide whether to queue a follow-up or restart a corrected request. Clearing playback and cancelling a solver need separate ownership rules on both the client and server.
