// The chat sidebar's "needs attention" card: what the Settings Dashboard flags (web/settings/attention.ts), shown at
// the top of the sidebar so it's in view on the first run (a harness that isn't installed, a speech model missing its
// key or still downloading, the microphone not allowed…). Each line opens Settings at its section. It hides when
// nothing is wrong; × hides it until something else needs attention.
import type { LlmChoice, LlmTier, SpeechLanguage, SttModel, TtsModel } from "../../shared/config.ts";
import {
  SECTION_LABELS, SERVER_DOWN, keyProblems, permissionProblems, sortProblems, speechProblems, speechStatusOf, tierProblems, verdict,
  type EngineState, type InstallState, type PermissionRow, type Problem, type ProviderInfo,
} from "../settings/attention.ts";

/** electron/preload.ts `attention`: the permissions, which keys are set (not their values) and their labels. */
export interface AttentionBridge {
  get(): Promise<{ permissions: PermissionRow[]; set: string[]; labels: Record<string, string>; unreadable: string[] } | null>;
  onChanged?(cb: () => void): void;
}

export interface AttentionDeps {
  bridge: AttentionBridge | undefined;
  openSettings(section: string): void;
  /** The current picks (they change from Settings). */
  current(): { llm: Record<LlmTier, LlmChoice>; sttModel: SttModel; ttsModel: TtsModel; language: SpeechLanguage };
}

/** A loading-only state shows only if it lasts this long (an engine loading at every launch shouldn't flash the card). */
const BUSY_GRACE_MS = 2500;

export function mountAttention(box: HTMLElement, deps: AttentionDeps): { refresh(): void } {
  let app: Awaited<ReturnType<AttentionBridge["get"]>> = null;
  let providers: ProviderInfo[] | null = null;
  let serverDown = false;
  let engines: EngineState[] = [];
  let installs: InstallState[] | undefined;
  let dismissed = "";
  let busySince = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const keyLabel = (k: string) => app?.labels[k] ?? k;

  function problems(): Problem[] {
    const cur = deps.current();
    const out: Problem[] = [];
    if (serverDown) out.push(SERVER_DOWN);
    if (providers) out.push(...tierProblems("fast", cur.llm.fast, providers), ...tierProblems("smart", cur.llm.smart, providers));
    if (!serverDown && providers && app) {
      const ctx = { env: Object.fromEntries(app.set.map((k) => [k, "1"])), language: cur.language, engines, installs, pending: false };
      out.push(...speechProblems("stt", speechStatusOf("stt", cur.sttModel, ctx, keyLabel)));
      out.push(...speechProblems("tts", speechStatusOf("tts", cur.ttsModel, ctx, keyLabel)));
    }
    if (app) out.push(...permissionProblems(app.permissions), ...keyProblems(app.unreadable, keyLabel));
    return sortProblems(out);
  }

  function render(): void {
    const list = problems();
    const v = verdict(list);
    const key = list.map((p) => `${p.tone}:${p.text}`).join("\n");
    if (v.tone === "busy") busySince ||= Date.now(); else busySince = 0;
    const waiting = v.tone === "busy" && Date.now() - busySince < BUSY_GRACE_MS;
    box.hidden = !list.length || key === dismissed || waiting;
    if (box.hidden) return;
    box.className = `panel attention ${v.tone}`;
    const head = document.createElement("div");
    head.className = "attn-head";
    const light = document.createElement("span");
    light.className = "attn-light";
    const title = document.createElement("strong");
    title.textContent = v.tone === "ok" ? "Heads-up" : v.title;
    const settings = document.createElement("button");
    settings.type = "button";
    settings.className = "attn-open";
    settings.textContent = "Settings";
    settings.title = "Open the Settings Dashboard";
    settings.onclick = () => deps.openSettings("dashboard");
    const close = document.createElement("button");
    close.type = "button";
    close.className = "attn-close";
    close.textContent = "×";
    close.title = "Hide until something else needs attention";
    close.setAttribute("aria-label", "Hide");
    close.onclick = () => { dismissed = key; box.hidden = true; };
    head.append(light, title, settings, close);
    const ul = document.createElement("ul");
    ul.className = "attn-list";
    ul.replaceChildren(...list.map((p) => {
      const li = document.createElement("li");
      li.className = p.tone;
      const dot = document.createElement("span");
      dot.className = "attn-dot";
      const text = document.createElement("span");
      text.className = "attn-text";
      text.textContent = p.text;
      const link = document.createElement("button");
      link.type = "button";
      link.className = "attn-link";
      const section = p.focusKey ? "keys" : p.section;
      link.textContent = `${SECTION_LABELS[section]} →`;
      link.title = `Open Settings → ${SECTION_LABELS[section]}`;
      link.onclick = () => deps.openSettings(section);
      li.append(dot, text, link);
      return li;
    }));
    box.replaceChildren(head, ul);
  }

  /** The app's side (permissions, keys): on load and when it changed (Settings saved, the window came back into focus). */
  async function loadApp(): Promise<void> {
    try { app = (await deps.bridge?.get()) ?? null; } catch { app = null; }
    render();
  }

  /** The server's side (harnesses, speech engines), polled: faster while something is loading. */
  async function poll(): Promise<void> {
    clearTimeout(timer);
    try {
      const [p, e] = await Promise.all([
        fetch("/api/llm/providers").then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json() as Promise<ProviderInfo[]>; }),
        fetch("/api/speech/engines").then((r) => (r.ok ? r.json() as Promise<{ engines: EngineState[]; installs?: InstallState[] }> : { engines: [] })),
      ]);
      providers = p;
      engines = e.engines;
      installs = e.installs;
      serverDown = false;
    } catch {
      serverDown = true;
    }
    render();
    const busy = verdict(problems()).tone === "busy";
    timer = setTimeout(() => void poll(), busy ? 1000 : serverDown ? 3000 : 10_000);
  }

  deps.bridge?.onChanged?.(() => { void loadApp(); void poll(); });
  void loadApp();
  void poll();
  return { refresh: render };
}
