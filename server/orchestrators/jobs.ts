// Background jobs (chat mode, RunConfig.backgroundLongTasks): a long task's Opus run continues after its
// turn ends. When it finishes, the client gets a `job` update, the result joins the conversation, and it's
// spoken as a notice once no turn is active, in the voice of the approach that started it (A/C: the
// connection's Realtime session; B, or if that session isn't available: ElevenLabs).
import { randomUUID } from "node:crypto";
import type { RunConfig } from "../../shared/config.ts";
import type { CostItem, Intent, JobInfo, PointingTarget } from "../../shared/protocol.ts";
import { opusCost, PRICES, realtimeResponseCost } from "../cost.ts";
import { getConversation, type ChatTurn } from "../conversation.ts";
import { idleRealtime } from "./shared.ts";
import { tracer } from "./trace.ts";
import type { ConnectionCache, ConnectionChannel, OrchestratorDeps } from "./types.ts";

const KEY = "jobs";
const noMark = () => {};

export interface JobSpec {
  turnId: string;
  config: RunConfig;
  intent: Intent;
  question: string;
  estimateS: number | null;
  pointing: PointingTarget[];
  history: ChatTurn[];
  pageContext?: string;
  language?: string;
}

class JobRegistry {
  cancelled = false;
  /** Notices are spoken one at a time, in completion order. */
  notices: Promise<void> = Promise.resolve();
  readonly jobs = new Map<string, JobInfo>();
}

function registry(conn: ConnectionCache): JobRegistry {
  let r = conn.get<JobRegistry>(KEY);
  if (!r) conn.set<JobRegistry>(KEY, (r = new JobRegistry()), (v) => { v.cancelled = true; });
  return r;
}

/** Forget every job on this connection (conversation reset / disconnect): results are dropped, not spoken. */
export function cancelJobs(conn: ConnectionCache): void {
  conn.delete(KEY);
}

/** First paragraph without the SPOKEN: prefix, for answers where the SPOKEN line never fired. */
export function spokenFallback(text: string): string {
  return text.split(/\n\s*\n/)[0]!.replace(/^\s*SPOKEN:\s*/i, "").trim().slice(0, 400);
}

/** Start a job; returns its initial info (already sent to the client). */
export function startJob(
  conn: ConnectionCache, channel: ConnectionChannel, deps: OrchestratorDeps, spec: JobSpec,
): JobInfo {
  const reg = registry(conn);
  const job: JobInfo = {
    jobId: randomUUID(), turnId: spec.turnId, approach: spec.config.approach, intent: spec.intent,
    question: spec.question, estimateS: spec.estimateS, state: "running",
  };
  reg.jobs.set(job.jobId, job);
  channel.send({ type: "job", job: { ...job } });
  const t0 = performance.now();
  let spoken = "";
  let text = "";

  deps.solveWithOpus({
    mark: noMark, question: spec.question, pointing: spec.pointing, fast: spec.config.opusFast,
    history: spec.history, intent: spec.intent, pageContext: spec.pageContext, language: spec.language, backend: spec.config.claudeBackend,
    ...tracer((m) => { if (!reg.cancelled) channel.send(m); }, spec.turnId, job.jobId)(),
    onSpokenLine: (l) => { spoken = l.trim(); },
    onDelta: (d) => { text += d; },
  }).then(
    (r) => {
      if (reg.cancelled) return;
      text = r.text || text;
      const opusUsd = opusCost(r.usage, false);
      Object.assign(job, {
        state: "done", spoken: spoken || spokenFallback(text) || "The task is done.", detail: text, elapsedMs: Math.round(performance.now() - t0),
        costUsd: opusUsd, costItems: [{ label: "Opus (background task)", usd: opusUsd }],
      });
      channel.send({ type: "job", job: { ...job } });
      getConversation(conn).push({
        turnId: job.jobId, approach: job.approach,
        user: `(Background task finished: ${spec.question})`, assistant: job.spoken!, detail: text,
      });
      reg.notices = reg.notices
        .then(() => announce(conn, channel, deps, spec.config, job, reg))
        .then((item) => {
          // Speaking the result costs too: add it once the notice has played.
          if (!item || reg.cancelled) return;
          job.costItems = [...(job.costItems ?? []), item];
          job.costUsd = (job.costUsd ?? 0) + item.usd;
          channel.send({ type: "job", job: { ...job } });
        })
        .catch((e) => console.warn("[jobs] notice failed", e));
    },
    (e) => {
      if (reg.cancelled) return;
      Object.assign(job, { state: "failed", error: e instanceof Error ? e.message : String(e), elapsedMs: Math.round(performance.now() - t0) });
      channel.send({ type: "job", job: { ...job } });
    },
  );
  return job;
}

/** Speak a finished job's result once the connection is idle; retried if a turn starts before any audio. */
async function announce(
  conn: ConnectionCache, channel: ConnectionChannel, deps: OrchestratorDeps, config: RunConfig, job: JobInfo, reg: JobRegistry,
): Promise<CostItem | null> {
  let cost: CostItem | null = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    await channel.whenIdle();
    if (reg.cancelled) return cost;
    const { outcome, item } = await speakOnce(conn, channel, deps, config, job);
    if (item) cost = cost ? { ...item, usd: cost.usd + item.usd } : item;
    if (outcome !== "preempted") return cost;
  }
  return cost;
}

type Outcome = "spoken" | "interrupted" | "preempted";

async function speakOnce(
  conn: ConnectionCache, channel: ConnectionChannel, deps: OrchestratorDeps, config: RunConfig, job: JobInfo,
): Promise<{ outcome: Outcome; item: CostItem | null }> {
  const text = job.spoken!;
  let aborted = false;
  let started = false;
  /** Audio goes out only while no turn is active; a turn that starts first preempts the notice. */
  const emit = (pcm: Buffer): void => {
    if (aborted) return;
    if (!channel.isIdle()) { aborted = true; abort?.(); return; }
    if (!started) { started = true; channel.send({ type: "notice", jobId: job.jobId, state: "start" }); }
    channel.sendAudio(pcm);
  };
  let abort: (() => void) | null = null;
  const outcome = (): Outcome => (aborted ? (started ? "interrupted" : "preempted") : "spoken");
  const finish = () => {
    channel.setNoticeAbort(null);
    if (started) channel.send({ type: "notice", jobId: job.jobId, state: "end" });
  };

  const rt = config.approach !== "pipeline" ? idleRealtime(conn) : null;
  let noticeUsage: unknown = null;
  const onResponseDone = (r: { label: string; response: unknown }) => {
    if (r.label === "notice") noticeUsage = (r.response as { usage?: unknown }).usage ?? null;
  };
  if (rt && rt.attach({ onAudio: emit, onText: () => {}, onToolCall: () => {}, onError: () => {}, onResponseDone })) {
    abort = () => rt.session.cancelResponse();
    channel.setNoticeAbort(() => { aborted = true; abort!(); });
    try {
      await rt.session.speak(text, "notice");
      if (!aborted) rt.seenTurns.add(job.jobId); // the session told the user itself: no recap later
    } catch (e) {
      if (!aborted) console.warn("[jobs] realtime notice failed", e);
    } finally {
      rt.attach(null);
      finish();
    }
    const usd = noticeUsage ? realtimeResponseCost(noticeUsage, config.realtimeModel) : 0;
    return { outcome: outcome(), item: usd ? { label: `OpenAI Realtime (spoken result, ${config.realtimeModel})`, usd } : null };
  }

  const voiceId = deps.voiceId ?? process.env.ELEVENLABS_VOICE_ID ?? "";
  if (!voiceId) return { outcome: "spoken", item: null };
  const tts = await deps.openTts({ mark: noMark, voiceId, model: config.ttsModel, segment: "answer" });
  abort = () => tts.close();
  tts.onAudio(emit);
  channel.setNoticeAbort(() => { aborted = true; abort!(); });
  try {
    tts.pushText(text);
    tts.flush();
    await tts.done().catch(() => {});
  } finally {
    finish();
  }
  const chars = tts.chars;
  return { outcome: outcome(), item: chars ? { label: `ElevenLabs TTS (spoken result, ${config.ttsModel})`, usd: chars * PRICES.elevenPerChar, detail: `${chars} chars` } : null };
}
