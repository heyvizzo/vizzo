// Settings → Speech to text / Text to speech: one row per model, grouped API access / On-device (speechModels.ts).
// A row's radio picks the model; its settings (voice, voice ID, Fish's direction…) sit next to it; the lines under its
// name say what's missing (clicking a missing key's line goes to that key under API keys) or what its engine is
// doing; on-device rows have Install / Cancel / Uninstall. The rows are built once and updated in place, so a field
// being typed in keeps its focus while the engine states are polled.
import type { SttModel, TtsModel } from "../../shared/config.ts";
import type { EngineState, InstallState } from "../../shared/protocol.ts";
import { fishVoice, type Settings } from "../chat/settings.ts";
import { fmtBytes } from "../chat/logic.ts";
import { STT_ROWS, TTS_ROWS, canSelect, installView, rowNotes, voiceNotes, type ModelRow, type SpeechKind } from "./speechModels.ts";

export interface SpeechDeps {
  settings: Settings;
  /** Save the chat settings (the selection and the per-model settings). */
  save(): void;
  /** The saved API keys and voice IDs. */
  env(): Record<string, string>;
  /** Save env values (merged with the rest; the server gets them at once). */
  saveEnv(patch: Record<string, string>): Promise<void>;
  keyLabel(key: string): string;
  /** Move the focus to an API key's field. */
  focusKey(key: string): void;
}

/** GET /api/tts/voices. Piper: `installed: false` for a catalog voice that downloads when picked. */
type VoiceOption = { id: string; label: string; default?: boolean; installed?: boolean; bytes?: number };

interface RowEls {
  row: ModelRow;
  el: HTMLElement;
  radio: HTMLInputElement;
  notes: HTMLElement;
  /** Env-backed fields by key (ElevenLabs' voice ID), for a note to focus. */
  envInputs: Map<string, HTMLInputElement>;
  voice?: HTMLSelectElement;
  install?: { text: HTMLElement; bar: HTMLProgressElement; button: HTMLButtonElement };
  /** Fill the row's fields from the settings. */
  fill(): void;
  /** The last Install / Uninstall request's error, shown until the next one. */
  failed?: string;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

function param(label: string, control: HTMLElement, wide = false): HTMLLabelElement {
  const l = el("label", wide ? "param wide" : "param");
  l.append(el("span", "param-label", label), control);
  return l;
}

function clamp(v: number, lo: number, hi: number, fallback: number): number {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
}

export function mountSpeech(deps: SpeechDeps, containers: Record<SpeechKind, HTMLElement>): { render(): void } {
  const { settings } = deps;
  let engines: EngineState[] = [];
  let installs: InstallState[] | undefined;
  let voices: Record<string, VoiceOption[]> = {};
  const pending = { tts: false, stt: false };
  /** A picked voice that's downloading, per model: it becomes the choice once it's here. */
  const wantedVoice = new Map<string, string>();
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  const rows: RowEls[] = [];

  const selectedId = (kind: SpeechKind) => (kind === "stt" ? settings.sttModel : settings.ttsModel);
  const installOf = (row: ModelRow) => (row.engine ? installs?.find((i) => i.kind === row.kind && i.engine === row.engine) : undefined);

  function pick(row: ModelRow): void {
    if (row.kind === "stt") settings.sttModel = row.id as SttModel;
    else settings.ttsModel = row.id as TtsModel;
    deps.save();
    sendSpeech(row.kind);
    render();
  }

  function envInput(r: RowEls, key: string, placeholder: string): HTMLInputElement {
    const input = el("input");
    input.type = "text";
    input.spellcheck = false;
    input.autocomplete = "off";
    input.placeholder = placeholder;
    input.onchange = () => { void deps.saveEnv({ [key]: input.value.trim() }).then(render); };
    r.envInputs.set(key, input);
    return input;
  }

  /** The fields next to a model: what it can be told besides the text. */
  function params(r: RowEls): HTMLElement[] {
    const id = r.row.id;
    if (id === "eleven_v4_turbo" || id === "eleven_flash_v2_5") {
      const input = envInput(r, "ELEVENLABS_VOICE_ID", "voice id");
      input.title = "The ElevenLabs voice (both ElevenLabs models use it).";
      const fill = r.fill;
      r.fill = () => { fill(); if (document.activeElement !== input) input.value = deps.env().ELEVENLABS_VOICE_ID ?? ""; };
      return [param("Voice ID", input, true)];
    }
    if (id === "fish_drama_3") {
      const voice = el("input");
      voice.type = "text";
      voice.spellcheck = false;
      voice.title = "Fish Audio Drama 3 voice model id, sent with every sentence so the voice stays the same.";
      const direction = el("input");
      direction.type = "text";
      direction.spellcheck = false;
      direction.placeholder = "the model decides";
      direction.title = "Said before each sentence in brackets (not spoken): e.g. calm, warm, thoughtful.";
      const speed = el("input");
      Object.assign(speed, { type: "number", min: "0.5", max: "2", step: "0.05", title: "0.5 slow to 2 fast" });
      const volume = el("input");
      Object.assign(volume, { type: "number", min: "0", max: "2", step: "0.1", title: "0 silent to 2 loud, after synthesis" });
      voice.onchange = () => { settings.ttsVoices = { ...settings.ttsVoices, fish_drama_3: voice.value.trim() }; deps.save(); r.fill(); };
      direction.onchange = () => { settings.ttsStyle = { ...settings.ttsStyle, direction: direction.value.trim() }; deps.save(); };
      speed.onchange = () => { settings.ttsStyle = { ...settings.ttsStyle, speed: clamp(Number(speed.value), 0.5, 2, 1) }; deps.save(); r.fill(); };
      volume.onchange = () => { settings.ttsStyle = { ...settings.ttsStyle, volume: clamp(Number(volume.value), 0, 2, 1) }; deps.save(); r.fill(); };
      const fill = r.fill;
      r.fill = () => {
        fill();
        voice.value = fishVoice(settings);
        direction.value = settings.ttsStyle.direction;
        speed.value = String(settings.ttsStyle.speed);
        volume.value = String(settings.ttsStyle.volume);
      };
      // Two lines: Voice ID, Speed / Direction, Volume.
      return [param("Voice ID", voice, true), param("Speed", speed), param("Direction", direction, true), param("Volume", volume)];
    }
    if (id === "openai_tts_1" || id === "kokoro" || id === "piper") {
      const select = el("select");
      select.title = "The voice for English. Romanian uses the model's own Romanian voice.";
      select.onchange = () => {
        const opt = voices[id]?.find((v) => v.id === select.value);
        if (opt?.installed === false) {
          downloadVoice(r, opt.id);
          select.value = currentVoice(id); // the old one stays until the new one is here
          return;
        }
        wantedVoice.delete(id);
        settings.ttsVoices = { ...settings.ttsVoices, [id]: select.value };
        deps.save();
      };
      r.voice = select;
      return [param("Voice", select, true)];
    }
    return [];
  }

  function build(row: ModelRow): RowEls {
    const item = el("div", "model");
    item.dataset.group = row.group;
    const radio = el("input");
    radio.type = "radio";
    radio.name = `${row.kind}-model`;
    radio.id = `model-${row.id}`;
    radio.value = row.id;
    radio.onchange = () => { if (radio.checked) pick(row); };
    const main = el("div", "model-main");
    const name = el("label", "model-name");
    name.htmlFor = radio.id;
    name.append(row.name, " ", el("span", "vendor", row.vendor));
    const notes = el("div", "model-notes");
    main.append(name, el("p", "hint", row.desc), notes);
    item.append(radio, main);
    const r: RowEls = { row, el: item, radio, notes, envInputs: new Map(), fill: () => {} };
    const fields = params(r);
    if (fields.length) {
      const box = el("div", "model-params");
      box.append(...fields);
      item.append(box);
    }
    if (row.group === "device") {
      const side = el("div", "model-install");
      const text = el("span", "install-text");
      const bar = el("progress");
      bar.max = 1;
      const button = el("button");
      button.type = "button";
      button.className = "small";
      button.onclick = () => installAction(r, button.dataset.action ?? "");
      side.append(button, text, bar);
      item.append(side);
      r.install = { text, bar, button };
    }
    return r;
  }

  function update(r: RowEls): void {
    const { row } = r;
    const selected = selectedId(row.kind) === row.id;
    const install = installOf(row);
    r.el.classList.toggle("selected", selected);
    r.radio.checked = selected;
    r.radio.disabled = !canSelect(row, install, selected);
    r.radio.title = r.radio.disabled ? "Install it first" : "";
    const notes = rowNotes(row, {
      selected, env: deps.env(), language: settings.language, install, engines, pending: pending[row.kind as SpeechKind],
    }, deps.keyLabel);
    if (r.failed) notes.unshift({ tone: "error", text: r.failed });
    notes.push(...voiceNotes(install, (v) => voices[row.id]?.find((o) => o.id === v)?.label ?? v));
    r.notes.replaceChildren(...notes.map((n) => {
      const line = el(n.focus ? "button" : "p", `model-note ${n.tone}`);
      if (n.tone === "loading") line.append(el("span", "spin"));
      line.append(n.text);
      if (line instanceof HTMLButtonElement) {
        line.type = "button";
        line.title = "Go to the field";
        line.onclick = () => {
          const own = r.envInputs.get(n.focus!);
          if (own) own.focus();
          else deps.focusKey(n.focus!);
        };
      }
      return line;
    }));
    if (r.voice) {
      const list = voices[row.id] ?? [];
      const ids = list.map((v) => v.id).join("\n");
      if (r.voice.dataset.ids !== ids) {
        r.voice.dataset.ids = ids;
        const option = (v: VoiceOption) => {
          const o = el("option", undefined, v.installed === false && v.bytes ? `${v.label} · ${fmtBytes(v.bytes)}` : v.label);
          o.value = v.id;
          return o;
        };
        const here = list.filter((v) => v.installed !== false);
        const more = list.filter((v) => v.installed === false);
        const group = el("optgroup");
        group.label = "Download";
        group.append(...more.map(option));
        r.voice.replaceChildren(...here.map(option), ...(more.length ? [group] : []));
      }
      if (document.activeElement !== r.voice) r.voice.value = currentVoice(row.id);
      // Piper lists the voices it has: none until it's installed.
      r.voice.closest("label")!.hidden = list.length === 0;
    }
    if (r.install) {
      const view = installView(row, install)!;
      const { text, bar, button } = r.install;
      text.textContent = view.text;
      text.title = view.text;
      bar.hidden = view.progress === undefined && !view.busy;
      // No value: the browser's own busy bar (indeterminate), for the steps that can't be measured.
      if (view.progress !== undefined) bar.value = view.progress;
      else bar.removeAttribute("value");
      button.hidden = !view.button;
      button.dataset.action = view.button ?? "";
      button.textContent = view.button === "install" ? "Install" : view.button === "cancel" ? "Cancel" : "Uninstall";
      button.className = view.button === "uninstall" ? "small danger" : view.button === "install" ? "small primary" : "small";
    }
  }

  /** The model's voice: the saved choice if it's there, else its default. */
  function currentVoice(model: string): string {
    const list = (voices[model] ?? []).filter((v) => v.installed !== false);
    const chosen = settings.ttsVoices[model as TtsModel];
    return chosen && list.some((v) => v.id === chosen) ? chosen : (list.find((v) => v.default) ?? list[0])?.id ?? "";
  }

  function render(): void {
    for (const r of rows) update(r);
  }

  function downloadVoice(r: RowEls, voice: string): void {
    wantedVoice.set(r.row.id, voice);
    r.failed = undefined;
    fetch("/api/speech/install", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: r.row.kind, engine: r.row.engine, action: "install-voice", voice }) })
      .then((res) => res.json() as Promise<{ installs: InstallState[]; error?: string }>)
      .then((j) => { installs = j.installs; if (j.error) { r.failed = j.error; wantedVoice.delete(r.row.id); } })
      .catch((e: unknown) => { r.failed = e instanceof Error ? e.message : String(e); })
      .finally(() => { render(); poll(600); });
  }

  for (const kind of ["stt", "tts"] as const) {
    const box = containers[kind];
    for (const group of ["api", "device"] as const) {
      box.append(el("h3", "group", group === "api" ? "API access" : "On-device"));
      for (const row of (kind === "stt" ? STT_ROWS : TTS_ROWS).filter((x) => x.group === group)) {
        const r = build(row);
        r.fill();
        rows.push(r);
        box.append(r.el);
      }
    }
  }

  // ── the server: engine and install states, the selection, installs ──
  const busy = () => engines.some((e) => e.state === "loading") || pending.tts || pending.stt
    || !!installs?.some((i) => i.state === "installing" || i.state === "queued");

  function poll(delayMs: number): void {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(() => {
      fetch("/api/speech/engines").then((r) => r.json() as Promise<{ engines: EngineState[]; installs?: InstallState[] }>)
        .then((j) => {
          const busyKeys = (list?: InstallState[]) => new Set((list ?? []).flatMap((i) => [
            ...(i.state === "installing" || i.state === "queued" ? [i.engine] : []),
            ...(i.voices ?? []).filter((v) => v.state !== "error").map((v) => `${i.engine}/${v.voice}`),
          ]));
          const before = busyKeys(installs);
          engines = j.engines;
          installs = j.installs;
          // An install or a voice download finished: list the voices it brought (and use a voice that was picked).
          const after = busyKeys(installs);
          if ([...before].some((k) => !after.has(k))) loadVoices();
          render();
        })
        .catch(() => {})
        .finally(() => poll(busy() ? 600 : 3000));
    }, delayMs);
  }

  /** Tell the server the selection (it switches the engines), and show the new one loading. */
  function sendSpeech(kind?: SpeechKind): void {
    if (kind) pending[kind] = true;
    render();
    fetch("/api/speech/selection", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tts: settings.ttsModel, stt: settings.sttModel }) })
      .then((r) => r.json() as Promise<{ engines: EngineState[] }>)
      .then((j) => { engines = j.engines; })
      .catch(() => {})
      .finally(() => { if (kind) pending[kind] = false; render(); poll(600); });
  }

  function installAction(r: RowEls, action: string): void {
    if (!r.row.engine || !action) return;
    if (action === "uninstall" && !confirm(`Uninstall ${r.row.name}? Its models are deleted from this Mac (${r.install?.text.textContent ?? ""}). You can install it again later.`)) return;
    const button = r.install!.button;
    button.disabled = true;
    r.failed = undefined;
    fetch("/api/speech/install", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: r.row.kind, engine: r.row.engine, action }) })
      .then((res) => res.json() as Promise<{ installs: InstallState[]; error?: string }>)
      .then((j) => {
        installs = j.installs;
        if (j.error) r.failed = j.error;
        if (action === "uninstall") loadVoices();
      })
      .catch((e: unknown) => { r.failed = e instanceof Error ? e.message : String(e); })
      .finally(() => { button.disabled = false; render(); poll(600); });
  }

  function loadVoices(): void {
    fetch("/api/tts/voices").then((r) => r.json()).then((v: Record<string, VoiceOption[]>) => {
      voices = v;
      for (const [model, voice] of wantedVoice) {
        if (!voices[model]?.some((o) => o.id === voice && o.installed !== false)) continue;
        wantedVoice.delete(model);
        settings.ttsVoices = { ...settings.ttsVoices, [model]: voice };
        deps.save();
      }
      render();
    }).catch(() => {});
  }

  loadVoices();
  render();
  // The server may have started with an older selection: send this one (a no-op when it's the same).
  sendSpeech();
  return {
    render(): void {
      for (const r of rows) r.fill();
      render();
    },
  };
}
