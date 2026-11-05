import { DRAWING_COLORS, DRAWING_STYLES, DRAWING_WIDTHS, drawingColorContrast, drawingDashArray, type DrawingStyle, type DrawingWidth } from '../../shared/annotations.ts';

export interface DrawingAppearance { color: string; width: DrawingWidth; style: DrawingStyle }
export interface DrawingPickers {
  elements: [HTMLDivElement, HTMLDivElement];
  close(restoreFocus?: boolean): boolean;
  contains(target: Node | null): boolean;
  setDisabled(disabled: boolean): void;
  destroy(): void;
}

export const DRAWING_PICKERS_CSS = `
.draw-picker { position:relative; flex:none; }
.draw-tools .draw-color-trigger,.draw-tools .draw-stroke-trigger,.draw-tools .draw-swatch { display:grid; place-items:center; width:30px; height:30px; padding:4px; }
.draw-tools .draw-color-trigger,.draw-tools .draw-swatch { border-radius:50%; }
.draw-tools .draw-stroke-trigger { position:relative; }
.draw-color-dot { display:grid; place-items:center; width:20px; height:20px; border-radius:50%; background:var(--draw-color); box-shadow:inset 0 0 0 1px rgb(0 0 0 / .15); color:var(--draw-check); pointer-events:none; }
.draw-tools .draw-picker > button[aria-expanded=true] { color:var(--ui-accent); background:var(--ui-selected); box-shadow:0 0 0 1px var(--ui-accent-line); }
.draw-popover { position:absolute; left:0; bottom:calc(100% + 10px); z-index:2; padding:10px; border:1px solid var(--ui-line); border-radius:16px; background:var(--ui-panel); box-shadow:0 6px 24px var(--ui-shadow); }
/* A hover bridge keeps the popup open while crossing the space above its trigger. */
.draw-popover::after { content:''; position:absolute; top:100%; left:0; right:0; height:11px; }
.draw-popover[hidden] { display:none; }
.draw-palette { display:grid; grid-template-columns:repeat(4,30px); gap:6px; }
.draw-tools .draw-swatch[aria-checked=true] { background:var(--ui-accent-soft); box-shadow:inset 0 0 0 2px var(--ui-accent); }
.draw-swatch[aria-checked=true] .draw-color-dot::after { content:'✓'; font-size:13px; font-weight:700; }
.draw-stroke-popover { width:224px; max-width:calc(100vw - 64px); box-sizing:border-box; }
.draw-picker-label { margin:0 0 6px; color:var(--ui-muted); font-size:11px; font-weight:600; }
.draw-style-options,.draw-width-options { display:grid; gap:4px; }
.draw-style-options { grid-template-columns:repeat(3,minmax(0,1fr)); margin-bottom:12px; }
.draw-width-options { grid-template-columns:repeat(5,minmax(0,1fr)); }
.draw-tools .draw-stroke-option { display:grid; justify-items:center; align-content:center; gap:4px; min-width:0; height:46px; padding:5px 2px; border:1px solid transparent; font-size:11px; }
.draw-tools .draw-stroke-option[aria-pressed=true] { color:var(--ui-accent); background:var(--ui-selected); border-color:var(--ui-accent-line); }
.draw-stroke-option svg { width:100%; max-width:44px; height:16px; pointer-events:none; }
.draw-stroke-trigger svg { width:22px; height:18px; pointer-events:none; }
.draw-width-level { position:absolute; right:1px; bottom:0; padding:0 2px; border-radius:3px; background:var(--ui-panel); font-size:9px; line-height:11px; font-weight:600; pointer-events:none; }
`;

interface Picker { root: HTMLDivElement; trigger: HTMLButtonElement; popup: HTMLDivElement; first(): HTMLButtonElement | undefined }
const labelStyle = (style: DrawingStyle) => style[0]!.toUpperCase() + style.slice(1);
function linePreview(style: DrawingStyle, width: number): string {
  const dash = drawingDashArray(style, width);
  return `<svg viewBox="0 0 44 16" aria-hidden="true"><path d="M6 8H38" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round"${dash === null ? '' : ` stroke-dasharray="${dash}"`}/></svg>`;
}

/** Mouse hover never moves keyboard focus. Keyboard users open a picker with Enter, Space or an arrow. */
export function createDrawingPickers(initial: DrawingAppearance, changed: (value: DrawingAppearance) => void): DrawingPickers {
  let value = { ...initial }, disabled = false, active: Picker | null = null, keyboardOpen = false;
  let suppressed: Picker | null = null, closeTimer: ReturnType<typeof setTimeout> | null = null;
  const pickers: Picker[] = [];
  const colorButtons = new Map<string, HTMLButtonElement>();
  const styleButtons = new Map<DrawingStyle, HTMLButtonElement>();
  const widthButtons = new Map<DrawingWidth, HTMLButtonElement>();
  const cancelClose = () => { if (closeTimer !== null) clearTimeout(closeTimer); closeTimer = null; };
  function close(restoreFocus = false): boolean {
    cancelClose();
    if (!active) return false;
    const picker = active;
    active = null; keyboardOpen = false;
    if (restoreFocus) suppressed = picker;
    const scope = picker.root.getRootNode() as Document | ShadowRoot;
    const hadFocus = picker.popup.contains(scope.activeElement);
    picker.popup.hidden = true; picker.trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus || hadFocus) picker.trigger.focus();
    return true;
  }
  function open(picker: Picker, focus = false) {
    if (disabled || (suppressed === picker && !focus)) return;
    cancelClose();
    if (active !== picker) { close(); active = picker; }
    picker.popup.hidden = false; picker.trigger.setAttribute('aria-expanded', 'true');
    if (focus) { suppressed = null; keyboardOpen = true; picker.first()?.focus(); }
  }
  function scheduleClose(picker: Picker) {
    if (suppressed === picker) suppressed = null;
    if (active !== picker || keyboardOpen) return;
    cancelClose();
    closeTimer = setTimeout(() => { closeTimer = null; if (active === picker && !keyboardOpen) close(); }, 140);
  }
  function mountPicker(name: string, popupRole: 'menu' | 'dialog', first: Picker['first']): Picker {
    const root = document.createElement('div'); root.className = `draw-picker draw-${name}-picker`;
    const trigger = document.createElement('button'); trigger.type = 'button'; trigger.className = `draw-${name}-trigger`;
    const popup = document.createElement('div'); popup.className = `draw-popover ${name === 'color' ? 'draw-palette' : 'draw-stroke-popover'}`;
    popup.id = `drawing-${name}-options`; popup.hidden = true; popup.setAttribute('role', popupRole);
    popup.setAttribute('aria-label', name === 'color' ? 'Drawing colors' : 'Stroke settings');
    trigger.setAttribute('aria-haspopup', popupRole); trigger.setAttribute('aria-controls', popup.id); trigger.setAttribute('aria-expanded', 'false');
    const picker = { root, trigger, popup, first }; pickers.push(picker);
    const hover = (e: PointerEvent) => { if (e.pointerType !== 'touch' && e.buttons === 0) open(picker); };
    root.addEventListener('pointerenter', hover);
    // Electron redirects pointermove into the closed shadow root; this also handles that input path.
    root.addEventListener('pointermove', hover);
    root.addEventListener('pointerleave', () => scheduleClose(picker));
    root.addEventListener('focusout', e => { if (active === picker && !root.contains(e.relatedTarget as Node | null)) close(); });
    trigger.addEventListener('keydown', e => {
      if (['Enter', ' ', 'ArrowUp', 'ArrowDown'].includes(e.key)) { e.preventDefault(); e.stopPropagation(); open(picker, true); }
    });
    popup.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
      else if (e.key === 'Tab' && popupRole === 'menu') close(true);
    });
    root.append(trigger, popup);
    return picker;
  }
  function navigate(group: HTMLElement, options: HTMLButtonElement[], columns: number) {
    group.addEventListener('keydown', e => {
      const index = options.indexOf(e.target as HTMLButtonElement);
      const steps: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns };
      const step = steps[e.key];
      if (index < 0 || (step === undefined && e.key !== 'Home' && e.key !== 'End')) return;
      e.preventDefault(); e.stopPropagation(); keyboardOpen = true;
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? options.length - 1 : (index + step! + options.length) % options.length;
      options.forEach((button, i) => { button.tabIndex = i === next ? 0 : -1; }); options[next]?.focus();
    });
  }
  function choose(next: Partial<DrawingAppearance>) {
    if (disabled) return;
    value = { ...value, ...next }; render(); changed({ ...value });
  }
  const colors = mountPicker('color', 'menu', () => colorButtons.get(value.color));
  const dot = document.createElement('span'); dot.className = 'draw-color-dot'; dot.setAttribute('aria-hidden', 'true'); colors.trigger.append(dot);
  for (const { name, value: color } of DRAWING_COLORS) {
    const swatch = document.createElement('button'); swatch.type = 'button'; swatch.className = 'draw-swatch';
    swatch.setAttribute('role', 'menuitemradio'); swatch.setAttribute('aria-label', name); swatch.title = name;
    swatch.style.setProperty('--draw-color', color); swatch.style.setProperty('--draw-check', drawingColorContrast(color));
    const chip = document.createElement('span'); chip.className = 'draw-color-dot'; chip.setAttribute('aria-hidden', 'true'); swatch.append(chip);
    swatch.onclick = () => { choose({ color }); close(true); };
    colorButtons.set(color, swatch); colors.popup.append(swatch);
  }
  navigate(colors.popup, [...colorButtons.values()], 4);

  const stroke = mountPicker('stroke', 'dialog', () => styleButtons.get(value.style));
  function optionGroup(label: string, className: string): HTMLDivElement {
    const heading = document.createElement('div'); heading.className = 'draw-picker-label'; heading.textContent = label;
    const group = document.createElement('div'); group.className = className; group.setAttribute('role', 'group'); group.setAttribute('aria-label', label);
    stroke.popup.append(heading, group); return group;
  }
  const styles = optionGroup('Line style', 'draw-style-options');
  for (const style of DRAWING_STYLES) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'draw-stroke-option';
    button.innerHTML = `${linePreview(style, 3)}<span>${labelStyle(style)}</span>`;
    button.setAttribute('aria-label', `${labelStyle(style)} stroke`); button.title = `${labelStyle(style)} stroke`;
    button.onclick = () => choose({ style }); styleButtons.set(style, button); styles.append(button);
  }
  navigate(styles, [...styleButtons.values()], 1);
  const widths = optionGroup('Stroke width', 'draw-width-options');
  DRAWING_WIDTHS.forEach((width, index) => {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'draw-stroke-option';
    button.innerHTML = `${linePreview('normal', width)}<span>${index + 1}</span>`;
    button.setAttribute('aria-label', `Width ${index + 1} of 5 (${width} px)`); button.title = `Level ${index + 1} · ${width} px`;
    button.onclick = () => choose({ width }); widthButtons.set(width, button); widths.append(button);
  });
  navigate(widths, [...widthButtons.values()], 1);

  function render() {
    const colorName = DRAWING_COLORS.find(c => c.value === value.color)?.name ?? value.color;
    colors.trigger.style.setProperty('--draw-color', value.color);
    colors.trigger.setAttribute('aria-label', `Drawing color: ${colorName}`);
    for (const [color, button] of colorButtons) { button.setAttribute('aria-checked', String(color === value.color)); button.tabIndex = color === value.color ? 0 : -1; }
    const level = DRAWING_WIDTHS.indexOf(value.width) + 1;
    stroke.trigger.innerHTML = `${linePreview(value.style, 3)}<span class="draw-width-level" aria-hidden="true">${level}</span>`;
    stroke.trigger.setAttribute('aria-label', `Stroke settings: ${labelStyle(value.style)}, width ${level} of 5 (${value.width} px)`);
    for (const [style, button] of styleButtons) { button.setAttribute('aria-pressed', String(style === value.style)); button.tabIndex = style === value.style ? 0 : -1; }
    for (const [width, button] of widthButtons) { button.setAttribute('aria-pressed', String(width === value.width)); button.tabIndex = width === value.width ? 0 : -1; }
  }
  const blur = () => { suppressed = null; close(); };
  window.addEventListener('blur', blur);
  render();
  return {
    elements: [colors.root, stroke.root], close,
    contains: target => pickers.some(picker => picker.root.contains(target)),
    setDisabled(next) {
      if (disabled === next) return;
      disabled = next;
      for (const picker of pickers) for (const button of picker.root.querySelectorAll('button')) button.disabled = next;
      if (next) close();
    },
    destroy() { close(); window.removeEventListener('blur', blur); for (const picker of pickers) picker.root.remove(); },
  };
}
