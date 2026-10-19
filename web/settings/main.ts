// The Settings window of the Electron app (electron/main.ts openSettings): a sidebar of sections, one shown at a time
// (the URL hash names it). Dashboard sums up the rest and flags what doesn't work; then the LLM tiers and how turns
// run, the speech models (speechView.ts: pick, configure, install), the app's macOS permissions, the debugging
// displays, the browser pane's cookies and the API keys. Chat settings save on every change (web/chat/settings.ts)
// and apply from the sidebar's next turn; the API keys save with the Save bar, which shows only while they're edited.
import "./settings.css";
import { API_PROVIDERS, HARNESSES, HARNESS_TOGGLES, LLM_DEFAULT_MODELS, LLM_PROVIDER_LABELS, TASK_TIMEOUT_MAX, TASK_TIMEOUT_MIN, cleanToggles, defaultLevel, isHarness, llmOf, toggleOn, type LlmProvider, type HarnessScan, type LlmChoice, type LlmModelInfo, type LlmTier, type RouterMode, type RunConfig, type SpeechLanguage } from "../../shared/config.ts";
import { attachCombo, type Combo } from "../chat/combo.ts";
import { LANGUAGES, LONG_TASK_MAX, LONG_TASK_MIN, PANEL_KEYS, loadSettings, saveSettingsKeys, type ChatSettingsBridge } from "../chat/settings.ts";
import { mountSpeech } from "./speechView.ts";
import type { SpeechKind } from "./speechModels.ts";

interface PermissionRow { id: string; name: string; ok: boolean; optional?: boolean; summary: string; instruction: string; action?: { id: string; label: string } }
interface EnvField { key: string; label: string; hint: string; secret?: boolean; param?: boolean }
/** electron/preload.ts: what this window uses. */
const shell = (window as unknown as { shell: {
  chatSettings: ChatSettingsBridge;
  importCookies(browser: string): Promise<{ imported: number; failed: number; message: string }>;
  clearCookies(): Promise<{ cleared: number; message: string }>;
  settings: {
    get(): Promise<{ permissions: PermissionRow[]; fields: EnvField[]; values: Record<string, string>; unreadable?: string[] } | null>;
    save(values: Record<string, string>): Promise<void>;
    refresh(): Promise<PermissionRow[]>;
    allowMicrophone(): Promise<PermissionRow[]>;
    allowKeychain(): Promise<PermissionRow[]>;
    openPrivacy(pane: string): Promise<void>;
  };
} }).shell;

const settings = loadSettings(shell.chatSettings);
const saveSettings = () => saveSettingsKeys(shell.chatSettings, settings, PANEL_KEYS);

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ── sections ───────────────────────────────────────
type Section = "dashboard" | "models" | "stt" | "tts" | "permissions" | "debugging" | "cookies" | "keys";
const SECTIONS: readonly Section[] = ["dashboard", "models", "stt", "tts", "permissions", "debugging", "cookies", "keys"];
const sectionOf = (hash: string): Section => SECTIONS.find((x) => `#${x}` === hash) ?? "dashboard";
function showSection(section: Section): void {
  for (const el of document.querySelectorAll<HTMLElement>("main section[data-section]")) el.hidden = el.dataset.section !== section;
  for (const a of document.querySelectorAll<HTMLAnchorElement>(".sidebar a")) {
    if (a.dataset.section === section) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  if (location.hash !== `#${section}`) history.replaceState(null, "", `#${section}`);
  document.querySelector("main")!.scrollTop = 0;
}
window.addEventListener("hashchange", () => showSection(sectionOf(location.hash)));
showSection(sectionOf(location.hash));

// The sidebar's width: drag its edge (double-click resets); kept in this window's storage.
{
  const SIDE_DEFAULT = 190, SIDE_MIN = 150, SIDE_MAX = 340;
  const setSide = (w: number) => document.body.style.setProperty("--side-w", `${Math.min(SIDE_MAX, Math.max(SIDE_MIN, Math.round(w)))}px`);
  const keepSide = (w: number) => { try { localStorage.setItem("settingsSidebarWidth", String(w)); } catch { /* not kept */ } };
  try { const w = Number(localStorage.getItem("settingsSidebarWidth")); if (w) setSide(w); } catch { /* default width */ }
  const handle = $("side-resize");
  handle.onpointerdown = (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add("resizing");
    handle.onpointermove = (m) => setSide(m.clientX);
    handle.onpointerup = (u) => {
      handle.onpointermove = handle.onpointerup = null;
      document.body.classList.remove("resizing");
      keepSide(Math.min(SIDE_MAX, Math.max(SIDE_MIN, u.clientX)));
    };
  };
  handle.ondblclick = () => { setSide(SIDE_DEFAULT); keepSide(SIDE_DEFAULT); };
}

// The Dashboard redraws after whatever it sums up changed, once per batch of changes (and never mid-setup).
let dashboardQueued = false;
function dashboardChanged(): void {
  if (dashboardQueued) return;
  dashboardQueued = true;
  queueMicrotask(() => { dashboardQueued = false; renderDashboard(); });
}

$("language").innerHTML = LANGUAGES.map((l) => `<option value="${l.id}">${l.label}</option>`).join("");

// ── conversation ───────────────────────────────────
const router = $<HTMLSelectElement>("router");
const longTask = $<HTMLInputElement>("long-task");
const language = $<HTMLSelectElement>("language");
router.onchange = () => { settings.routerMode = router.value as RouterMode; saveSettings(); dashboardChanged(); };
// The long-task threshold: whole seconds in range, saved as typed; anything else is flagged and not saved.
const longTaskError = $("long-task-error");
function checkLongTask(): number | null {
  const raw = longTask.value.trim();
  const n = Number(raw);
  const error = raw === "" || longTask.validity.badInput ? "Enter a number of seconds."
    : !Number.isInteger(n) ? "Use whole seconds."
    : n < LONG_TASK_MIN || n > LONG_TASK_MAX ? `Between ${LONG_TASK_MIN} and ${LONG_TASK_MAX} seconds.` : "";
  longTaskError.textContent = error;
  longTaskError.hidden = !error;
  longTask.setAttribute("aria-invalid", String(!!error));
  return error ? null : n;
}
longTask.oninput = () => {
  const n = checkLongTask();
  if (n === null || n === settings.longTaskSeconds) return;
  settings.longTaskSeconds = n;
  saveSettings();
  dashboardChanged();
};
// Left invalid: back to the saved value.
longTask.onblur = () => { if (checkLongTask() === null) { longTask.value = String(settings.longTaskSeconds); checkLongTask(); } };
// The task time limit: whole minutes in range, like the long-task threshold.
const taskTimeout = $<HTMLInputElement>("task-timeout");
const taskTimeoutError = $("task-timeout-error");
function checkTaskTimeout(): number | null {
  const raw = taskTimeout.value.trim();
  const n = Number(raw);
  const error = raw === "" || taskTimeout.validity.badInput ? "Enter a number of minutes."
    : !Number.isInteger(n) ? "Use whole minutes."
    : n < TASK_TIMEOUT_MIN || n > TASK_TIMEOUT_MAX ? `Between ${TASK_TIMEOUT_MIN} and ${TASK_TIMEOUT_MAX} minutes.` : "";
  taskTimeoutError.textContent = error;
  taskTimeoutError.hidden = !error;
  taskTimeout.setAttribute("aria-invalid", String(!!error));
  return error ? null : n;
}
taskTimeout.oninput = () => {
  const n = checkTaskTimeout();
  if (n === null || n === settings.taskTimeoutMinutes) return;
  settings.taskTimeoutMinutes = n;
  saveSettings();
  dashboardChanged();
};
taskTimeout.onblur = () => { if (checkTaskTimeout() === null) { taskTimeout.value = String(settings.taskTimeoutMinutes); checkTaskTimeout(); } };
language.onchange = () => { settings.language = language.value as SpeechLanguage; saveSettings(); speech.render(); };

// ── speech to text, text to speech ─────────────────
// The saved API keys and voice IDs (the API keys form below edits the keys): the rows flag a model whose key is missing.
let envFields: EnvField[] = [];
let envValues: Record<string, string> = {};
const speech = mountSpeech({
  settings,
  save: saveSettings,
  env: () => envValues,
  saveEnv: async (patch) => {
    envValues = { ...envValues, ...patch };
    await shell.settings.save(envValues);
  },
  keyLabel,
  focusKey,
  onRender: dashboardChanged,
}, { stt: $("stt-models"), tts: $("tts-models") });

// ── models ─────────────────────────────────────────
// Model tiers: harness (GET /api/llm/providers: which are installed) + model (any id; suggestions with
// their levels and speeds from GET /api/llm/models) + level + speed, where the model offers them. Every change
// goes to the server (POST /api/llm/selection), which saves it and re-warms: it kills the other agents and
// starts ones for this choice. Switching back to a harness restores the choice last used with it. Under a harness,
// checkboxes for what its agents load besides their file tools (shared/config.ts HARNESS_TOGGLES). The model APIs
// (OpenRouter, Cerebras…) are offered on the fast tier only: the solver needs a harness's file tools.
type ProviderInfo = Omit<HarnessScan, "models" | "error">;
let providers: ProviderInfo[] = [
  ...HARNESSES.map((id) => ({ id, label: LLM_PROVIDER_LABELS[id], available: true })),
  ...API_PROVIDERS.map((id) => ({ id, label: LLM_PROVIDER_LABELS[id], available: true, api: true })),
];
const modelLists = new Map<LlmProvider, Promise<LlmModelInfo[]>>();
const loadedModels = new Map<LlmProvider, LlmModelInfo[]>();
const modelCombos: Record<LlmTier, Combo> = { fast: attachCombo($<HTMLInputElement>("llm-fast-model")), smart: attachCombo($<HTMLInputElement>("llm-smart-model")) };
const tierEls = (tier: LlmTier) => ({
  provider: $<HTMLSelectElement>(`llm-${tier}-provider`), model: $<HTMLInputElement>(`llm-${tier}-model`), combo: modelCombos[tier],
  level: $<HTMLSelectElement>(`llm-${tier}-level`), speed: $<HTMLSelectElement>(`llm-${tier}-speed`),
  toggles: $(`llm-${tier}-toggles`),
});
const modelInfo = (c: LlmChoice): LlmModelInfo | undefined => loadedModels.get(c.provider)?.find((m) => m.id === c.model);
/** The voice server didn't answer (no project folder chosen yet). */
let serverDown = false;
const scanBtn = $<HTMLButtonElement>("llm-scan");
const scanNote = $("llm-scan-note");
function note(text: string, isErr = false, title = ""): void {
  scanNote.textContent = text;
  scanNote.title = title;
  scanNote.classList.toggle("err", isErr);
}

function modelsOf(provider: LlmProvider): Promise<LlmModelInfo[]> {
  let list = modelLists.get(provider);
  if (!list) {
    list = fetch(`/api/llm/models?provider=${encodeURIComponent(provider)}`).then((r) => r.json() as Promise<LlmModelInfo[]>).catch(() => []);
    list.then((m) => { loadedModels.set(provider, m); });
    modelLists.set(provider, list);
  }
  return list;
}

/** Keep the level and speed to what the model offers (a level it lacks → the tier's default one), the toggles to the harness's. */
function fitChoice(tier: LlmTier, c: LlmChoice): LlmChoice {
  const toggles = isHarness(c.provider) ? cleanToggles(c.provider, c.toggles) : undefined;
  const { toggles: _t, ...rest } = c;
  const kept = toggles ? { ...rest, toggles } : rest;
  const info = modelInfo(c);
  if (!info) return kept; // unknown model (typed in, or the list hasn't loaded): keep what was chosen
  const level = c.level && info.levels.includes(c.level) ? c.level : defaultLevel(info, tier);
  return {
    provider: c.provider, model: c.model, ...(level ? { level } : {}), ...(c.speed === "fast" && info.fast ? { speed: "fast" as const } : {}),
    ...(toggles ? { toggles } : {}),
  };
}

/** Save and send the selection: the server re-warms its agents for it. */
function applyLlm(): void {
  saveSettings();
  void fetch("/api/llm/selection", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(settings.llm) }).catch(() => {});
}

function setTier(tier: LlmTier, c: LlmChoice): void {
  const fitted = fitChoice(tier, c);
  settings.llm = { ...settings.llm, [tier]: fitted };
  settings.llmModels = { ...settings.llmModels, [tier]: { ...settings.llmModels[tier], [fitted.provider]: fitted } };
  applyLlm();
  renderTier(tier);
}

function renderTier(tier: LlmTier): void {
  const el = tierEls(tier);
  const choice = settings.llm[tier];
  el.provider.replaceChildren(...providers.filter((p) => tier === "fast" || !p.api).map((p) => {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = p.available ? p.label : `${p.label} (${p.api ? "no key" : "not installed"})`;
    o.disabled = !p.available && p.id !== choice.provider;
    if (p.note) o.title = p.note;
    return o;
  }));
  el.provider.value = choice.provider;
  el.model.value = choice.model;
  el.model.placeholder = `${LLM_PROVIDER_LABELS[choice.provider]} default`;
  el.model.title = choice.model || `${LLM_PROVIDER_LABELS[choice.provider]}'s default model`;
  const info = modelInfo(choice);
  const levels = info?.levels ?? (choice.level ? [choice.level] : []);
  el.level.hidden = levels.length === 0;
  el.level.replaceChildren(...levels.map((l) => { const o = document.createElement("option"); o.value = l; o.textContent = l; return o; }));
  if (choice.level) el.level.value = choice.level;
  el.speed.hidden = !(info?.fast || choice.speed === "fast");
  el.speed.value = choice.speed ?? "standard";
  renderToggles(tier);
  dashboardChanged();
  void modelsOf(choice.provider).then((models) => {
    if (settings.llm[tier].provider !== choice.provider) return;
    el.combo.setOptions(models.map((m) => m.id));
    // Levels and speeds arrived after the first render: show them (once).
    if (!info && modelInfo(choice)) renderTier(tier);
  });
}

/** The tier harness's checkboxes; a change re-warms like any other. */
function renderToggles(tier: LlmTier): void {
  const box = tierEls(tier).toggles;
  const choice = settings.llm[tier];
  const harness = choice.provider;
  box.hidden = !isHarness(harness);
  if (!isHarness(harness)) { box.replaceChildren(); return; }
  box.replaceChildren(...HARNESS_TOGGLES[harness].map((t) => {
    const label = document.createElement("label");
    label.className = "check";
    label.title = t.hint;
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = toggleOn(harness, choice.toggles, t.id);
    input.onchange = () => {
      const cur = settings.llm[tier];
      setTier(tier, { ...cur, toggles: { ...cur.toggles, [t.id]: input.checked } });
    };
    label.append(input, t.label);
    return label;
  }));
}

for (const tier of ["fast", "smart"] as const) {
  const el = tierEls(tier);
  el.provider.onchange = () => {
    const provider = el.provider.value as LlmProvider;
    const info = providers.find((p) => p.id === provider);
    if (info && !info.available) note(`${info.label}: ${info.note ?? "not installed"}`, true);
    const last = settings.llmModels[tier][provider];
    const next = last ?? { provider, model: LLM_DEFAULT_MODELS[provider][tier] ?? "" };
    // Fit the level/speed once the harness's model list is in.
    void modelsOf(provider).then(() => setTier(tier, next));
  };
  el.model.onchange = () => {
    const { provider } = settings.llm[tier];
    const model = el.model.value.trim();
    const { speed, toggles } = settings.llm[tier];
    setTier(tier, { provider, model, ...(speed ? { speed } : {}), ...(toggles ? { toggles } : {}) });
  };
  el.level.onchange = () => setTier(tier, { ...settings.llm[tier], level: el.level.value });
  el.speed.onchange = () => {
    const { speed: _old, ...rest } = settings.llm[tier];
    setTier(tier, el.speed.value === "fast" ? { ...rest, speed: "fast" } : rest);
  };
}
// Scan harnesses: which are installed and every one's models, listed afresh (POST /api/llm/scan). The choices are
// refitted to what the models now offer; only an actual change is sent, since each one re-warms the agents.
scanBtn.onclick = async () => {
  scanBtn.disabled = true;
  note("Scanning…");
  try {
    const r = await fetch("/api/llm/scan", { method: "POST" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const scan = (await r.json()) as HarnessScan[];
    providers = scan.map(({ models: _m, error: _e, ...p }) => p);
    // A harness that failed to list keeps the models it had.
    for (const h of scan) if (!h.error) { loadedModels.set(h.id, h.models); modelLists.set(h.id, Promise.resolve(h.models)); }
    let changed = false;
    for (const tier of ["fast", "smart"] as const) {
      const fitted = fitChoice(tier, settings.llm[tier]);
      if (JSON.stringify(fitted) === JSON.stringify(settings.llm[tier])) continue;
      settings.llm = { ...settings.llm, [tier]: fitted };
      settings.llmModels = { ...settings.llmModels, [tier]: { ...settings.llmModels[tier], [fitted.provider]: fitted } };
      changed = true;
    }
    if (changed) applyLlm();
    renderTier("fast");
    renderTier("smart");
    const ok = scan.filter((h) => h.available && !h.error && !h.api);
    const apis = scan.filter((h) => h.available && !h.error && h.api);
    const failed = scan.filter((h) => h.error);
    note(
      `${ok.length} harness${ok.length === 1 ? "" : "es"}, ${apis.length} API${apis.length === 1 ? "" : "s"}, ${[...ok, ...apis].reduce((n, h) => n + h.models.length, 0)} models`
        + (failed.length ? ` · couldn't list ${failed.map((h) => h.label).join(", ")}` : ""),
      failed.length > 0,
      [...failed.map((h) => `${h.label}: ${h.error}`), ...scan.filter((h) => !h.available).map((h) => `${h.label}: ${h.note ?? "not installed"}`)].join("\n"),
    );
  } catch (e) {
    note(`Scan failed: ${e instanceof Error ? e.message : String(e)}`, true);
  } finally {
    scanBtn.disabled = false;
  }
};
// No voice server yet (no project folder chosen): the lists stay at their defaults.
fetch("/api/llm/providers").then((r) => r.json()).then((p: ProviderInfo[]) => { providers = p; renderTier("fast"); renderTier("smart"); })
  .catch(() => {
    serverDown = true;
    note("The voice server isn't running yet: choose a project folder to list the harnesses and models.", true);
    dashboardChanged();
  });
// The server's saved selection is what its agents are warm for: show it.
fetch("/api/llm/selection").then((r) => r.json()).then((sel: RunConfig["llm"]) => {
  settings.llm = llmOf({ llm: sel });
  saveSettings();
  renderTier("fast");
  renderTier("smart");
}).catch(() => {});

// ── display ────────────────────────────────────────
for (const [id, key] of [["debug-outlines", "debugOutlines"], ["hover-outline", "hoverOutline"], ["show-ram", "showRam"], ["show-cost", "showCost"], ["show-debug", "showDebug"]] as const) {
  const box = $<HTMLInputElement>(id);
  box.checked = settings[key];
  box.onchange = () => { settings[key] = box.checked; saveSettings(); dashboardChanged(); };
}

function renderSettings(): void {
  router.value = settings.routerMode;
  longTask.value = String(settings.longTaskSeconds);
  taskTimeout.value = String(settings.taskTimeoutMinutes);
  language.value = settings.language;
  renderTier("fast");
  renderTier("smart");
  speech.render();
}
renderSettings();

// ── cookies ────────────────────────────────────────
// Importing copies another browser's cookies into the browser pane; Clear empties the pane's. Either reloads the page.
{
  const buttons = [...document.querySelectorAll<HTMLButtonElement>("#cookies button")];
  const status = $("cookies-status");
  const show = (text: string, isErr = false) => {
    status.textContent = text;
    status.classList.toggle("error", isErr);
  };
  const run = async (button: HTMLButtonElement, work: () => Promise<void>) => {
    for (const b of buttons) b.disabled = true;
    try {
      await work();
    } catch (err) {
      show(err instanceof Error ? err.message : String(err), true);
    } finally {
      for (const b of buttons) b.disabled = false;
      button.focus();
    }
  };
  for (const button of buttons) {
    const browser = button.dataset.browser;
    button.onclick = () => {
      if (!browser) {
        if (!confirm("Clear every cookie in the browser pane? Sites there will sign you out. Chrome, Safari and Firefox keep theirs.")) return;
        void run(button, async () => { show("Clearing cookies…"); show((await shell.clearCookies()).message); });
        return;
      }
      void run(button, async () => {
        show(`Importing from ${button.textContent}…`);
        const result = await shell.importCookies(browser);
        show(result.message, result.imported === 0 && !result.message.startsWith("No cookies"));
      });
    };
  }
}

// ── permissions and API keys ───────────────────────
const permissions = $("permissions");
const fields = $("fields");
const saveStatus = $("save-status");
const savebar = $("savebar");
let permissionRows: PermissionRow[] | undefined;
let unreadableKeys: string[] = [];

function renderPermissions(rows: PermissionRow[]): void {
  permissionRows = rows;
  dashboardChanged();
  permissions.replaceChildren(...rows.map((row) => {
    const article = document.createElement("article");
    article.className = row.ok ? "row ok" : "row";
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.title = row.summary;
    const body = document.createElement("div");
    const title = document.createElement("div");
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = row.name;
    const summary = document.createElement("span");
    summary.className = "summary";
    summary.textContent = " · " + row.summary;
    title.append(name, summary);
    const instruction = document.createElement("p");
    instruction.className = "instruction";
    instruction.textContent = row.instruction;
    body.append(title, instruction);
    if (row.action) {
      const { id, label } = row.action;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "small";
      button.textContent = label;
      button.title = row.instruction;
      button.onclick = () => act(id, button);
      body.append(button);
    }
    article.append(dot, body);
    return article;
  }));
}

async function act(id: string, button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  try {
    if (id === "allow-microphone") renderPermissions(await shell.settings.allowMicrophone());
    else if (id === "allow-keychain") renderPermissions(await shell.settings.allowKeychain());
    else if (id === "open-microphone") await shell.settings.openPrivacy("microphone");
    else if (id === "open-full-disk") await shell.settings.openPrivacy("full-disk");
  } finally {
    button.disabled = false;
  }
}

function fieldControl(field: EnvField, value: string | undefined): HTMLLabelElement {
  const label = document.createElement("label");
  const name = document.createElement("span");
  name.className = "label";
  name.textContent = field.label;
  const hint = document.createElement("span");
  hint.className = "hint";
  hint.textContent = field.hint;
  label.append(name, hint);
  const input = document.createElement("input");
  input.name = field.key;
  input.id = `env-${field.key}`;
  input.value = value || "";
  input.spellcheck = false;
  input.autocomplete = "off";
  if (field.secret) {
    input.type = "password";
    const wrap = document.createElement("div");
    wrap.className = "secret";
    const reveal = document.createElement("button");
    reveal.type = "button";
    reveal.textContent = "Show";
    reveal.title = "Show or hide the key";
    reveal.onclick = () => {
      const hidden = input.type === "password";
      input.type = hidden ? "text" : "password";
      reveal.textContent = hidden ? "Hide" : "Show";
    };
    wrap.append(input, reveal);
    label.append(wrap);
  } else {
    input.type = "text";
    label.append(input);
  }
  return label;
}

$("refresh").onclick = async () => {
  renderPermissions(await shell.settings.refresh());
};

// ── the Save bar: shown while a key differs from its saved value, and for a moment after a save ──
const keyInputs = () => [...fields.querySelectorAll<HTMLInputElement>("input[name]")];
const keysDirty = () => keyInputs().some((i) => i.value !== (envValues[i.name] ?? ""));
let savedTimer: ReturnType<typeof setTimeout> | undefined;
function updateSavebar(): void {
  const dirty = keysDirty();
  if (dirty && !saveStatus.classList.contains("error")) saveStatus.textContent = "API keys changed.";
  savebar.hidden = !dirty && !savedTimer && !saveStatus.classList.contains("error");
}
$("keys").addEventListener("input", () => {
  clearTimeout(savedTimer);
  savedTimer = undefined;
  saveStatus.classList.remove("error");
  updateSavebar();
});
$("discard").onclick = () => {
  for (const input of keyInputs()) input.value = envValues[input.name] ?? "";
  saveStatus.classList.remove("error");
  updateSavebar();
};

$<HTMLFormElement>("keys").onsubmit = async (event) => {
  event.preventDefault();
  const save = $<HTMLButtonElement>("save");
  if (!keysDirty()) return;
  // The voice IDs aren't in this form (they sit next to their models): keep them, as they are when the save lands.
  const form = Object.fromEntries([...new FormData(event.target as HTMLFormElement).entries()].map(([k, v]) => [k, String(v)]));
  const values = { ...envValues, ...form };
  save.disabled = true;
  saveStatus.classList.remove("error");
  saveStatus.textContent = "Saving…";
  try {
    await shell.settings.save(values);
    envValues = { ...envValues, ...form };
    // A key typed in again is readable now.
    unreadableKeys = unreadableKeys.filter((k) => !form[k]?.trim());
    renderUnreadable();
    speech.render();
    saveStatus.textContent = "Saved. The next request uses these keys.";
    savedTimer = setTimeout(() => { savedTimer = undefined; updateSavebar(); }, 2500);
  } catch (err) {
    saveStatus.textContent = err instanceof Error ? err.message : String(err);
    saveStatus.classList.add("error");
  } finally {
    save.disabled = false;
    updateSavebar();
  }
};

function keyLabel(key: string): string {
  return envFields.find((f) => f.key === key)?.label ?? key;
}

/** Show API Keys and move the focus to a key's field, flashing it. */
function focusKey(key: string): void {
  const input = document.getElementById(`env-${key}`) as HTMLInputElement | null;
  if (!input) return;
  showSection("keys");
  input.scrollIntoView({ block: "center" });
  input.focus({ preventScroll: true });
  const field = input.closest("label");
  field?.classList.remove("flash");
  void field?.offsetWidth; // restart the animation
  field?.classList.add("flash");
}

function renderUnreadable(): void {
  const box = $("keys-unreadable");
  box.hidden = unreadableKeys.length === 0;
  box.textContent = `Couldn't decrypt the saved ${unreadableKeys.map(keyLabel).join(", ")}: macOS didn't allow access to this app's Keychain entry. Enter ${unreadableKeys.length === 1 ? "it" : "them"} again.`;
  dashboardChanged();
}

void shell.settings.get().then((data) => {
  if (!data) return;
  renderPermissions(data.permissions);
  envFields = data.fields;
  envValues = data.values;
  // Saved keys macOS wouldn't decrypt (Keychain access denied, or its entry was deleted): they read as missing.
  unreadableKeys = data.unreadable ?? [];
  renderUnreadable();
  fields.replaceChildren(...data.fields.filter((field) => !field.param).map((field) => fieldControl(field, data.values[field.key])));
  speech.render();
});


// ── dashboard ──────────────────────────────────────
// A summary line per part of the setup, and above it one verdict: green when nothing is failing, red with the
// problems (each a link to its section) when something is, grey while an engine is still loading.
type Tone = "ok" | "bad" | "warn" | "busy";
interface Problem { tone: Tone; text: string; section: Section; focusKey?: string }
const SECTION_LABELS: Record<Section, string> = {
  dashboard: "Dashboard", models: "Models", stt: "Speech to text (STT)", tts: "Text to speech (TTS)", permissions: "Permissions",
  debugging: "Debugging", cookies: "Browser cookies", keys: "API Keys",
};

function go(p: { section: Section; focusKey?: string }): void {
  if (p.focusKey && document.getElementById(`env-${p.focusKey}`)) focusKey(p.focusKey);
  else showSection(p.section);
}

function tierText(c: LlmChoice): { text: string; loads?: string } {
  const parts = [LLM_PROVIDER_LABELS[c.provider], c.model || "default model", c.level, c.speed === "fast" ? "fast" : undefined];
  const harness = c.provider;
  const loads = isHarness(harness) ? HARNESS_TOGGLES[harness].filter((t) => toggleOn(harness, c.toggles, t.id)).map((t) => t.label) : undefined;
  return { text: parts.filter(Boolean).join(" · "), ...(loads ? { loads: loads.length ? `Loads ${loads.join(", ")}` : "File tools only" } : {}) };
}

function tierProblems(tier: LlmTier): Problem[] {
  const c = settings.llm[tier];
  const p = providers.find((x) => x.id === c.provider);
  if (p && !p.available) {
    return [{ tone: "bad", text: `${tier === "fast" ? "Fast" : "Smart"} tier: ${p.label} ${p.api ? "has no API key" : "isn't installed"}${p.note ? ` (${p.note})` : ""}.`, section: "models" }];
  }
  return [];
}

function speechProblems(kind: SpeechKind): Problem[] {
  const st = speech.status(kind);
  if (!st) return [];
  const section: Section = kind;
  const label = kind === "stt" ? "Speech to text" : "Text to speech";
  return st.notes.filter((n) => n.tone !== "muted" && n.tone !== "ok").map((n) => ({
    tone: n.tone === "error" ? "bad" : n.tone === "loading" ? "busy" : "warn",
    text: `${label} (${st.row.name}): ${n.text}`,
    section,
    ...(n.focus ? { focusKey: n.focus } : {}),
  }));
}

function speechLine(kind: SpeechKind): { text: string; detail: string; tone: Tone } {
  const st = speech.status(kind);
  if (!st) return { text: "Nothing picked", detail: "", tone: "bad" };
  const probs = speechProblems(kind);
  const tone: Tone = probs.some((p) => p.tone === "bad") ? "bad" : probs.some((p) => p.tone === "busy") ? "busy" : probs.length ? "warn" : "ok";
  const ok = st.notes.find((n) => n.tone === "ok")?.text;
  const lang = kind === "stt" ? `Language: ${LANGUAGES.find((l) => l.id === settings.language)?.label ?? settings.language}` : undefined;
  const voice = st.voice ? `Voice: ${st.voice}` : undefined;
  const where = st.row.group === "device" ? "On-device" : "API";
  return {
    text: `${st.row.name} · ${st.row.vendor}`,
    detail: [where, lang, voice, probs[0]?.text.replace(/^[^:]+: /, "") ?? ok].filter(Boolean).join(" · "),
    tone,
  };
}

function renderDashboard(): void {
  const problems: Problem[] = [];
  if (serverDown) problems.push({ tone: "bad", text: "The voice server isn't running: choose a project folder in the main window.", section: "models" });
  problems.push(...tierProblems("fast"), ...tierProblems("smart"), ...speechProblems("stt"), ...speechProblems("tts"));
  for (const row of permissionRows ?? []) {
    if (!row.ok && !row.optional) problems.push({ tone: "bad", text: `${row.name}: ${row.summary}. ${row.instruction}`, section: "permissions" });
  }
  if (unreadableKeys.length) problems.push({ tone: "bad", text: `Couldn't decrypt the saved ${unreadableKeys.map(keyLabel).join(", ")}: enter ${unreadableKeys.length === 1 ? "it" : "them"} again.`, section: "keys" });

  const bad = problems.filter((p) => p.tone === "bad");
  const busy = problems.filter((p) => p.tone === "busy");
  const overall: Tone = bad.length ? "bad" : busy.length ? "busy" : "ok";
  const health = $("health");
  health.className = `health card ${overall}`;
  const head = document.createElement("div");
  head.className = "health-head";
  const light = document.createElement("span");
  light.className = "light";
  const title = document.createElement("strong");
  title.textContent = overall === "bad" ? `${bad.length} thing${bad.length === 1 ? " needs" : "s need"} attention`
    : overall === "busy" ? "Starting up…" : "Everything works";
  const sub = document.createElement("span");
  sub.className = "hint";
  sub.textContent = overall === "ok" ? (problems.length ? "A heads-up below, nothing failing." : "Models, speech, permissions and keys are all set.") : "";
  head.append(light, title, sub);
  const list = document.createElement("ul");
  list.className = "problems";
  // Failures first, then what's loading, then warnings.
  const order: Record<Tone, number> = { bad: 0, busy: 1, warn: 2, ok: 3 };
  list.replaceChildren(...[...problems].sort((a, b) => order[a.tone] - order[b.tone]).map((p) => {
    const li = document.createElement("li");
    li.className = p.tone;
    const dot = document.createElement("span");
    dot.className = "dot";
    const text = document.createElement("span");
    text.textContent = p.text;
    const link = document.createElement("button");
    link.type = "button";
    link.className = "link";
    link.textContent = p.focusKey ? "API Keys →" : `${SECTION_LABELS[p.section]} →`;
    link.onclick = () => go(p);
    li.append(dot, text, link);
    return li;
  }));
  health.replaceChildren(head, ...(problems.length ? [list] : []));
  $("nav-health").className = `nav-dot ${overall}`;

  // The summary: what's set up, a line per part.
  const fast = tierText(settings.llm.fast);
  const smart = tierText(settings.llm.smart);
  const stt = speechLine("stt");
  const tts = speechLine("tts");
  const tierTone = (tier: LlmTier): Tone => serverDown || tierProblems(tier).length ? "bad" : "ok";
  const perms = permissionRows;
  const granted = perms?.filter((r) => r.ok).length ?? 0;
  const missingRequired = perms?.some((r) => !r.ok && !r.optional) ?? false;
  const keyFields = envFields.filter((f) => !f.param);
  const keysSet = keyFields.filter((f) => envValues[f.key]?.trim()).length;
  const display = ([["showCost", "Cost"], ["showRam", "RAM"], ["showDebug", "Details"], ["debugOutlines", "Outlines"], ["hoverOutline", "Hover outline"]] as const)
    .filter(([k]) => settings[k]).map(([, l]) => l);
  const lines: { label: string; text: string; detail?: string; tone?: Tone; section: Section }[] = [
    { label: "Fast model", text: fast.text, detail: [fast.loads, "router and progress lines"].filter(Boolean).join(" · "), tone: tierTone("fast"), section: "models" },
    { label: "Smart model", text: smart.text, detail: [smart.loads, "the solver"].filter(Boolean).join(" · "), tone: tierTone("smart"), section: "models" },
    { label: "Speech to text", ...stt, section: "stt" },
    { label: "Text to speech", ...tts, section: "tts" },
    {
      label: "Permissions", text: perms ? `${granted} of ${perms.length} granted` : "Checking…",
      detail: perms?.filter((r) => !r.ok).map((r) => r.optional ? `${r.name} (optional)` : r.name).join(", ") || undefined,
      tone: perms ? (missingRequired ? "bad" : "ok") : "busy", section: "permissions",
    },
    { label: "Turns", text: `Router ${settings.routerMode === "auto" ? "auto (may answer)" : "forced (always the solver)"}`, detail: `Long tasks: over ${settings.longTaskSeconds} s · time limit ${settings.taskTimeoutMinutes} min`, section: "models" },
    { label: "Debugging", text: display.length ? display.join(", ") : "Nothing extra shown", section: "debugging" },
    {
      label: "API keys", text: envFields.length ? `${keysSet} of ${keyFields.length} set` : "Loading…",
      detail: unreadableKeys.length ? `Couldn't decrypt ${unreadableKeys.map(keyLabel).join(", ")}` : "Only the picked models' keys are needed",
      tone: unreadableKeys.length ? "bad" : undefined, section: "keys",
    },
  ];
  $("summary").replaceChildren(...lines.map((l) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `summary-row ${l.tone ?? ""}`;
    row.title = `Go to ${SECTION_LABELS[l.section]}`;
    const label = document.createElement("span");
    label.className = "summary-label";
    label.textContent = l.label;
    const body = document.createElement("span");
    body.className = "summary-body";
    const text = document.createElement("span");
    text.className = "summary-text";
    text.textContent = l.text;
    body.append(text);
    if (l.detail) {
      const detail = document.createElement("span");
      detail.className = "hint";
      detail.textContent = l.detail;
      body.append(detail);
    }
    const dot = document.createElement("span");
    dot.className = l.tone ? "dot" : "dot none";
    row.append(dot, label, body);
    row.onclick = () => showSection(l.section);
    return row;
  }));
}
renderDashboard();
