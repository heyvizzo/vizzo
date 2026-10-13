// /audio-test: mic (or WAV replay) → server echo → player round trip, with capture-to-played delay per turn.
import { connectWithStatus } from "../common.ts";
import { startCapture } from "./capture.ts";
import { warmUpAudio } from "./context.ts";
import { RATE, firstNonSilent } from "./dsp.ts";
import { createPlayer, type Player } from "./player.ts";
import { bindPushToTalk } from "./ptt.ts";
import { startReplay } from "./replay.ts";

const sock = connectWithStatus();
const renderStatus = sock.onStatus;
sock.onStatus = (s) => {
  renderStatus?.(s);
  if (s === "open") sock.send({ type: "echo", on: true });
};

document.getElementById("app")!.innerHTML = `
  <div class="panel" style="display:flex;flex-direction:column;gap:12px;max-width:760px">
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <button id="enable">Enable audio</button>
      <button id="ptt" disabled style="touch-action:none;user-select:none;min-width:160px">Hold to talk (Space)</button>
      <input id="file" type="file" accept=".wav,audio/wav" />
      <button id="replay" disabled>Replay WAV</button>
    </div>
    <div id="status" class="mono" style="color:var(--muted)">Click “Enable audio” to allow the mic. The server echoes audio back while no turn is active.</div>
    <table class="mono" style="border-collapse:collapse;width:100%">
      <thead><tr style="text-align:left;color:var(--muted)">
        <th>#</th><th>source</th><th>press→audioStart</th><th>frames</th><th>capture→played</th><th>RTT</th>
      </tr></thead>
      <tbody id="rows"></tbody>
    </table>
    <div style="color:var(--muted)">capture→played = time the first non-silent echoed sample left the speaker minus the time that same sample
      was captured (tAudioStart + its offset). It includes the 20 ms framing, network RTT, server and playback latency.</div>
  </div>`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const enableBtn = $<HTMLButtonElement>("enable");
const pttBtn = $<HTMLButtonElement>("ptt");
const fileInput = $<HTMLInputElement>("file");
const replayBtn = $<HTMLButtonElement>("replay");
const statusEl = $("status");
const rows = $("rows");

interface Turn {
  n: number;
  source: "mic" | "file";
  tPress: number;
  tAudioStart: number | null;
  frames: number;
  /** Offset (24 kHz samples from the turn start) of the first non-silent captured sample. */
  onsetSample: number | null;
  tPlayed: number | null;
  row: HTMLTableRowElement;
  stop?: () => void;
}

let player: Player | null = null;
let turn: Turn | null = null;
let turnCount = 0;

const fmt = (ms: number | null) => (ms === null ? "–" : `${ms.toFixed(1)} ms`);

function render(t: Turn): void {
  const delay = t.tPlayed !== null && t.tAudioStart !== null && t.onsetSample !== null ? t.tPlayed - (t.tAudioStart + (t.onsetSample / RATE) * 1000) : null;
  t.row.innerHTML = `<td>${t.n}</td><td>${t.source}</td><td>${fmt(t.tAudioStart === null ? null : t.tAudioStart - t.tPress)}</td>
    <td>${t.frames}</td><td><strong>${fmt(delay)}</strong></td><td>${fmt(sock.clock?.rttMs ?? null)}</td>`;
}

function newTurn(source: Turn["source"]): Turn {
  turn?.stop?.();
  const row = document.createElement("tr");
  rows.prepend(row);
  const t: Turn = { n: ++turnCount, source, tPress: performance.now(), tAudioStart: null, frames: 0, onsetSample: null, tPlayed: null, row };
  player?.reset();
  player?.startSegment("answer");
  turn = t;
  render(t);
  return t;
}

function onFrame(t: Turn, pcm: Int16Array<ArrayBuffer>): void {
  if (t.onsetSample === null) {
    const i = firstNonSilent(pcm);
    if (i >= 0) t.onsetSample = t.frames * pcm.length + i;
  }
  t.frames++;
  sock.sendAudio(pcm);
  render(t);
}

sock.onAudio((pcm) => player?.push(pcm));

enableBtn.onclick = async () => {
  try {
    await warmUpAudio();
    player = await createPlayer();
    player.onPlayed = (_segment, tPlayed) => {
      if (!turn || turn.tPlayed !== null) return;
      turn.tPlayed = tPlayed;
      render(turn);
    };
    enableBtn.disabled = true;
    pttBtn.disabled = false;
    replayBtn.disabled = !fileInput.files?.length;
    statusEl.textContent = "Ready. Hold the button or Space, speak, release; you should hear yourself back.";
  } catch (e) {
    statusEl.textContent = `Audio init failed: ${(e as Error).message}`;
  }
};

bindPushToTalk({
  button: pttBtn,
  onPress: () => {
    if (pttBtn.disabled) return;
    const t = newTurn("mic");
    pttBtn.textContent = "Talking…";
    let released = false;
    t.stop = () => {
      released = true;
    };
    startCapture({ onFrame: (pcm) => onFrame(t, pcm) })
      .then((h) => {
        if (released) return h.stop();
        t.stop = () => h.stop();
        h.tAudioStart.then((ts) => {
          t.tAudioStart = ts;
          render(t);
        }, () => {});
      })
      .catch((e: Error) => (statusEl.textContent = `Capture failed: ${e.message}`));
  },
  onRelease: () => {
    pttBtn.textContent = "Hold to talk (Space)";
    turn?.stop?.();
  },
});

fileInput.onchange = () => {
  replayBtn.disabled = !player || !fileInput.files?.length;
};

replayBtn.onclick = async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  const wav = await file.arrayBuffer();
  const t = newTurn("file");
  const h = startReplay({ wav, onFrame: (pcm) => onFrame(t, pcm) });
  t.stop = () => h.stop();
  h.tAudioStart.then((ts) => {
    t.tAudioStart = ts;
    render(t);
  }, (e: Error) => (statusEl.textContent = `Replay failed: ${e.message}`));
  void h.done.then(() => (statusEl.textContent = `Replay of ${file.name} finished (${t.frames} frames).`));
};
