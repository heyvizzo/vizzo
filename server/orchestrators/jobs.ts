// Background jobs (chat mode, RunConfig.backgroundLongTasks): a long task's the solver run continues after its
// turn ends. When it finishes, the client gets a `job` update, the result joins the conversation, and it's
// spoken as a notice once no turn is active, with the turn's TTS engine. The user can stop one (stopJob): its
// solver is killed and nothing is announced.
import { randomUUID } from "node:crypto";
import { isLocalTts, llmOf, taskTimeoutMs, TTS_LABELS, type RunConfig } from "../../shared/config.ts";
import type { CostItem, Intent, JobInfo, PointingTarget } from "../../shared/protocol.ts";
import { llmCostItem, PRICES } from "../cost.ts";
import { getConversation, type ChatTurn } from "../conversation.ts";
import { tracer } from "./trace.ts";
import { useVoiceCues } from "../adapters/voiceCues.ts";
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
  /** Running jobs' aborts (stopJob). */
  readonly aborts = new Map<string, AbortController>();
}

function registry(conn: ConnectionCache): JobRegistry {
  let r = conn.get<JobRegistry>(KEY);
  if (!r) {
    conn.set<JobRegistry>(KEY, (r = new JobRegistry()), (v) => {
      v.cancelled = true;
      for (const a of v.aborts.values()) a.abort(new Error("conversation reset"));
    });
  }
  return r;
}

/** Forget every job on this connection (conversation reset / disconnect): results are dropped, not spoken. */
export function cancelJobs(conn: ConnectionCache): void {
  conn.delete(KEY);
}

/**
 * The user stopped a running job: its solver is killed, it's marked stopped (the client gets the update) and the
 * conversation notes it. False if it isn't running (already finished, or unknown).
 */
export function stopJob(conn: ConnectionCache, channel: ConnectionChannel, jobId: string): boolean {
  const reg = conn.get<JobRegistry>(KEY);
  const job = reg?.jobs.get(jobId);
  if (!reg || !job || job.state !== "running") return false;
  Object.assign(job, { state: "stopped" });
  reg.aborts.get(jobId)?.abort(new Error("stopped by the user"));
  reg.aborts.delete(jobId);
  channel.send({ type: "job", job: { ...job } });
  getConversation(conn).push({
    turnId: job.jobId, approach: job.approach, user: `(Background task stopped by the user: ${job.question})`, assistant: "", detail: "",
  });
  return true;
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
    question: spec.question, estimateS: spec.estimateS, state: "running", ...(spec.language ? { language: spec.language } : {}),
  };
  reg.jobs.set(job.jobId, job);
  channel.send({ type: "job", job: { ...job } });
  const t0 = performance.now();
  let spoken = "";
  let text = "";
  const abort = new AbortController();
  reg.aborts.set(job.jobId, abort);
  // Stopped (stopJob): what the solver says after that is dropped.
  const live = () => !reg.cancelled && job.state === "running";

  deps.solveTask({
    signal: abort.signal, timeoutMs: taskTimeoutMs(spec.config),
    mark: noMark, question: spec.question, pointing: spec.pointing, fast: spec.config.solverFast,
    history: spec.history, intent: spec.intent, pageContext: spec.pageContext, language: spec.language, llm: llmOf(spec.config).smart,
    voiceCues: useVoiceCues(spec.config.ttsModel, spec.language),
    ...tracer((m) => { if (!reg.cancelled) channel.send(m); }, spec.turnId, job.jobId)(),
    onSpokenLine: (l) => { spoken = l.trim(); },
    onDelta: (d) => { text += d; },
  }).finally(() => reg.aborts.delete(job.jobId)).then(
    (r) => {
      if (!live()) return;
      text = r.text || text;
      const item = llmCostItem(spec.config, "smart", r.usage, "Background solver");
      Object.assign(job, {
        state: "done", spoken: spoken || spokenFallback(text) || "The task is done.", detail: text, elapsedMs: Math.round(performance.now() - t0),
        costUsd: item.usd,
        costItems: [item],
      });
      channel.send({ type: "job", job: { ...job } });
      getConversation(conn).push({
        turnId: job.jobId, approach: job.approach,
        user: `(Background task finished: ${spec.question})`, assistant: job.spoken!, detail: text,
      });
      reg.notices = reg.notices
        .then(() => announce(channel, deps, spec.config, job, reg))
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
      if (!live()) return;
      Object.assign(job, { state: "failed", error: e instanceof Error ? e.message : String(e), elapsedMs: Math.round(performance.now() - t0) });
      channel.send({ type: "job", job: { ...job } });
    },
  );
  return job;
}

/** Speak a finished job's result once the connection is idle; retried if a turn starts before any audio. */
async function announce(
  channel: ConnectionChannel, deps: OrchestratorDeps, config: RunConfig, job: JobInfo, reg: JobRegistry,
): Promise<CostItem | null> {
  let cost: CostItem | null = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    await channel.whenIdle();
    if (reg.cancelled) return cost;
    const { outcome, item } = await speakOnce(channel, deps, config, job);
    if (item) cost = cost ? { ...item, usd: cost.usd + item.usd } : item;
    if (outcome !== "preempted") return cost;
  }
  return cost;
}

type Outcome = "spoken" | "interrupted" | "preempted";

async function speakOnce(
  channel: ConnectionChannel, deps: OrchestratorDeps, config: RunConfig, job: JobInfo,
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

  const voiceId = deps.voiceId ?? process.env.ELEVENLABS_VOICE_ID ?? "";
  if (!voiceId && config.ttsModel.startsWith("eleven_")) return { outcome: "spoken", item: null };
  const tts = await deps.openTts({ mark: noMark, voiceId, model: config.ttsModel, segment: "answer", language: job.language, style: config.ttsStyle, ...(config.ttsVoice ? { voice: config.ttsVoice } : {}) });
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
  return { outcome: outcome(), item: chars ? spokenCostItem(config, chars) : null };
}

/** What speaking a result outside a turn cost (the TTS path; on-device engines: 0, with what was saved). */
export function spokenCostItem(config: RunConfig, chars: number): CostItem {
  return isLocalTts(config.ttsModel)
    ? { label: `${TTS_LABELS[config.ttsModel]} (spoken result, on-device)`, usd: 0, savedUsd: chars * PRICES.elevenPerChar, savedVia: "on-device" as const, detail: `${chars} chars` }
    : config.ttsModel === "openai_tts_1"
      ? { label: "OpenAI TTS (spoken result, tts-1)", usd: chars * PRICES.openaiTtsPerChar, detail: `${chars} chars` }
      : config.ttsModel === "fish_drama_3"
        ? { label: "Fish Audio TTS (spoken result, drama-3)", usd: chars * PRICES.fishTtsPerChar, detail: `${chars} chars` }
        : { label: `ElevenLabs TTS (spoken result, ${config.ttsModel})`, usd: chars * PRICES.elevenPerChar, detail: `${chars} chars` };
}
