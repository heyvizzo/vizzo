// The Settings window of the Electron app (electron/main.ts openSettings): the conversation settings, the speech
// models (speechView.ts: pick, configure, install), the LLM tiers, the display settings, the browser pane's cookies,
// the app's macOS permissions and its API keys. Chat settings save on every change (web/chat/settings.ts) and apply
// from the sidebar's next turn; the API keys save with their button.
import "./settings.css";
import { API_PROVIDERS, HARNESSES, LLM_DEFAULT_MODELS, LLM_PROVIDER_LABELS, defaultLevel, llmOf, type LlmProvider, type HarnessScan, type LlmChoice, type LlmModelInfo, type LlmTier, type RouterMode, type RunConfig, type SpeechLanguage } from "../../shared/config.ts";
import { attachCombo, type Combo } from "../chat/combo.ts";
import { LANGUAGES, LONG_TASK_CHOICES, PANEL_KEYS, loadSettings, saveSettingsKeys, type ChatSettingsBridge } from "../chat/settings.ts";
import { mountSpeech } from "./speechView.ts";

interface PermissionRow { id: string; name: string; ok: boolean; summary: string; instruction: string; action?: { id: string; label: string } }
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
    openPrivacy(pane: string): Promise<void>;
  };
} }).shell;

const settings = loadSettings(shell.chatSettings);
const saveSettings = () => saveSettingsKeys(shell.chatSettings, settings, PANEL_KEYS);

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

$("language").innerHTML = LANGUAGES.map((l) => `<option value="${l.id}">${l.label}</option>`).join("");
$("long-task").innerHTML = LONG_TASK_CHOICES.map((s) => `<option value="${s}">${s} s</option>`).join("");

// ── conversation ───────────────────────────────────
const router = $<HTMLSelectElement>("router");
const longTask = $<HTMLSelectElement>("long-task");
const language = $<HTMLSelectElement>("language");
router.onchange = () => { settings.routerMode = router.value as RouterMode; saveSettings(); };
longTask.onchange = () => { settings.longTaskSeconds = Number(longTask.value); saveSettings(); };
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
  keyLabel: (key) => envFields.find((f) => f.key === key)?.label ?? key,
  focusKey: (key) => {
    const input = document.getElementById(`env-${key}`) as HTMLInputElement | null;
    if (!input) return;
    input.scrollIntoView({ block: "center", behavior: "smooth" });
    input.focus({ preventScroll: true });
    const field = input.closest("label");
    field?.classList.remove("flash");
    void field?.offsetWidth; // restart the animation
    field?.classList.add("flash");
  },
}, { stt: $("stt-models"), tts: $("tts-models") });

// ── models ─────────────────────────────────────────
// Model tiers: harness (GET /api/llm/providers: which are installed) + model (any id; suggestions with
// their levels and speeds from GET /api/llm/models) + level + speed, where the model offers them. Every change
// goes to the server (POST /api/llm/selection), which saves it and re-warms: it kills the other agents and
// starts ones for this choice. Switching back to a harness restores the choice last used with it. The model APIs
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
});
const modelInfo = (c: LlmChoice): LlmModelInfo | undefined => loadedModels.get(c.provider)?.find((m) => m.id === c.model);
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

/** Keep the level and speed to what the model offers (a level it lacks → the tier's default one). */
function fitChoice(tier: LlmTier, c: LlmChoice): LlmChoice {
  const info = modelInfo(c);
  if (!info) return c; // unknown model (typed in, or the list hasn't loaded): keep what was chosen
  const level = c.level && info.levels.includes(c.level) ? c.level : defaultLevel(info, tier);
  return { provider: c.provider, model: c.model, ...(level ? { level } : {}), ...(c.speed === "fast" && info.fast ? { speed: "fast" as const } : {}) };
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
  void modelsOf(choice.provider).then((models) => {
    if (settings.llm[tier].provider !== choice.provider) return;
    el.combo.setOptions(models.map((m) => m.id));
    // Levels and speeds arrived after the first render: show them (once).
    if (!info && modelInfo(choice)) renderTier(tier);
  });
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
    setTier(tier, { provider, model, ...(settings.llm[tier].speed ? { speed: settings.llm[tier].speed } : {}) });
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
  .catch(() => note("The voice server isn't running yet: choose a project folder to list the harnesses and models.", true));
// The server's saved selection is what its agents are warm for: show it.
fetch("/api/llm/selection").then((r) => r.json()).then((sel: RunConfig["llm"]) => {
  settings.llm = llmOf({ llm: sel });
  saveSettings();
  renderTier("fast");
  renderTier("smart");
}).catch(() => {});

// ── display ────────────────────────────────────────
for (const [id, key] of [["debug-outlines", "debugOutlines"], ["hover-outline", "hoverOutline"], ["show-ram", "showRam"], ["show-cost", "showCost"]] as const) {
  const box = $<HTMLInputElement>(id);
  box.checked = settings[key];
  box.onchange = () => { settings[key] = box.checked; saveSettings(); };
}

function renderSettings(): void {
  router.value = settings.routerMode;
  longTask.value = String(settings.longTaskSeconds);
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

function renderPermissions(rows: PermissionRow[]): void {
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

$<HTMLFormElement>("keys").onsubmit = async (event) => {
  event.preventDefault();
  const save = $<HTMLButtonElement>("save");
  // The voice IDs aren't in this form (they sit next to their models): keep them, as they are when the save lands.
  const form = Object.fromEntries([...new FormData(event.target as HTMLFormElement).entries()].map(([k, v]) => [k, String(v)]));
  const values = { ...envValues, ...form };
  save.disabled = true;
  saveStatus.classList.remove("error");
  saveStatus.textContent = "Saving…";
  try {
    await shell.settings.save(values);
    envValues = { ...envValues, ...form };
    speech.render();
    saveStatus.textContent = "Saved. The next request uses these keys.";
  } catch (err) {
    saveStatus.textContent = err instanceof Error ? err.message : String(err);
    saveStatus.classList.add("error");
  } finally {
    save.disabled = false;
  }
};

void shell.settings.get().then((data) => {
  if (!data) return;
  renderPermissions(data.permissions);
  envFields = data.fields;
  envValues = data.values;
  // Saved keys macOS wouldn't decrypt (Keychain access denied, or its entry was deleted): they read as missing.
  if (data.unreadable?.length) {
    const names = data.unreadable.map((k) => data.fields.find((f) => f.key === k)?.label ?? k).join(", ");
    saveStatus.classList.add("error");
    saveStatus.textContent = `Couldn't decrypt the saved ${names}: macOS didn't allow access to this app's Keychain entry. Enter ${data.unreadable.length === 1 ? "it" : "them"} again.`;
  }
  fields.replaceChildren(...data.fields.filter((field) => !field.param).map((field) => fieldControl(field, data.values[field.key])));
  speech.render();
});

