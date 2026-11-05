import { DRAWING_COLOR, DRAWING_WIDTH, drawingSvg, MAX_DRAWING_STROKES, MAX_DRAWING_POINTS, MAX_DRAWING_IMAGE_CHARS, MAX_DRAWING_TARGETS, type DrawingAnnotation, type DrawingPoint, type DrawingStroke, type DrawingTool } from '../../shared/annotations.ts';
import { drawingAnchor, drawingMarkerSample } from '../../shared/anchor.ts';
import type { CursorSample } from '../../shared/protocol.ts';
import { createDrawingPickers, DRAWING_PICKERS_CSS, type DrawingAppearance, type DrawingPickers } from './drawingPickers.ts';
import { drawingPreviewOpen } from './drawingPreview.ts';
import { hitDrawingStroke, selectionBounds, translateDrawingSelection } from './drawingGeometry.ts';
import { createDrawingSpeech, type DrawingSelectionChange } from './drawingSpeech.ts';
import { createDrawingSpeechPanel, DRAWING_SPEECH_PANEL_CSS } from './drawingSpeechPanel.ts';
import { talkHint, type FormHub, type InlineForm } from './inlineForm.ts';

export const DRAWING_CSS = `
.draw-overlay { position:fixed; inset:0; z-index:100; pointer-events:auto; background:#171719; color:var(--ui-text); font:13px/1.4 -apple-system,BlinkMacSystemFont,sans-serif; }
.draw-stage { position:absolute; overflow:hidden; touch-action:none; cursor:crosshair; }
.draw-stage[data-select=true] { cursor:grab; }
.draw-stage[data-dragging=true] { cursor:grabbing; }
.draw-stage:focus { outline:none; }
.draw-stage img,.draw-ink,.draw-selection { position:absolute; inset:0; width:100%; height:100%; pointer-events:none; }
.draw-ink svg,.draw-selection svg { width:100%; height:100%; }
.draw-shape-tip { position:absolute; padding:2px 7px; border-radius:6px; background:#000c; color:#fff; font:600 11px/1.5 -apple-system,BlinkMacSystemFont,sans-serif; white-space:nowrap; pointer-events:none; }
.draw-controls { position:absolute; left:50%; bottom:20px; transform:translateX(-50%); width:min(590px,calc(100% - 24px)); box-sizing:border-box; padding:10px; border:1px solid var(--ui-line); border-radius:18px; background:var(--ui-panel,var(--ui-sunken)); box-shadow:0 8px 32px #0005; cursor:default; }
.draw-tools { display:flex; align-items:center; gap:3px; margin-bottom:8px; flex-wrap:wrap; }
.draw-tools button { border:0; background:transparent; color:var(--ui-muted); border-radius:7px; padding:6px 8px; cursor:pointer; font:inherit; }
.draw-tools button:hover:not(:disabled) { background:var(--ui-hover); color:var(--ui-text); }
.draw-tools > button[aria-pressed=true] { color:var(--ui-on-accent); background:var(--ui-accent-gradient); }
.draw-tools > button[aria-pressed=true]:hover:not(:disabled) { color:var(--ui-on-accent); background:var(--ui-accent-gradient-hover); }
.draw-tools button:focus-visible { outline:2px solid var(--ui-accent); outline-offset:2px; }
.draw-tools button:disabled { opacity:.35; cursor:default; }
.draw-tools .draw-close { margin-left:auto; }
${DRAWING_PICKERS_CSS}
${DRAWING_SPEECH_PANEL_CSS}
.draw-note { padding:5px 3px 0; font-size:11px; color:var(--ui-muted); }
`;
interface Target { sample: CursorSample; rect: DOMRect }
interface Options {
  layer: HTMLElement;
  attach(): void;
  forms: FormHub;
  capture(): Promise<string>;
  snapshot(): Target[];
  send(text: string, sample: CursorSample | null, annotation: DrawingAnnotation): void;
  requestMode(on: boolean): void;
}
const uid = () => crypto.randomUUID?.() ?? `drawing-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const now = () => performance.timeOrigin + performance.now();
type EditorTool = DrawingTool | 'select';
const loadImage = (src: string) => new Promise<HTMLImageElement>((resolve, reject) => {
  const img = new Image(); img.onload = () => resolve(img); img.onerror = () => reject(new Error('Could not load captured image')); img.src = src;
});

const SCROLL_KEYS = new Set([' ','PageUp','PageDown','Home','End','ArrowUp','ArrowDown','ArrowLeft','ArrowRight']);

/** All marks and element hits refer to the immutable captured viewport, including after a resize. */
export function createDrawingOverlay(o: Options) {
  let on = false, generation = 0, busy = false;
  let root: HTMLDivElement | null = null, stage: HTMLDivElement | null = null, ink: HTMLDivElement | null = null, selectionInk: HTMLDivElement | null = null, shapeTip: HTMLDivElement | null = null;
  let form: InlineForm | null = null, note: HTMLDivElement | null = null;
  let image = '', pageUrl = '', createdAt = 0;
  let viewport = { width: 1, height: 1, scrollX: 0, scrollY: 0 };
  let targets: Target[] = [], strokes: DrawingStroke[] = [], history: DrawingStroke[][] = [[]], historyIndex = 0, pending: DrawingStroke | null = null;
  let tool: EditorTool = 'pen';
  let selected = new Set<string>(), selections: DrawingSelectionChange[] = [], nextLabel = 1;
  let drag: { pointerId:number; origin:DrawingPoint; strokes:DrawingStroke[]; ids:Set<string> } | null = null;
  let pointerId: number | null = null, fieldText = '';
  let voiceWarnings: string[] = [];
  const speech = createDrawingSpeech();
  let speechPanel: ReturnType<typeof createDrawingSpeechPanel> | null = null;
  let appearance: DrawingAppearance = { color: DRAWING_COLOR, width: DRAWING_WIDTH, style: 'normal' };
  let pickers: DrawingPickers | null = null;
  const buttons = new Map<string, HTMLButtonElement>();
  const commands = new Map<string, ()=>void>();
  const run = (name: string) => { if (!buttons.get(name)?.disabled) commands.get(name)?.(); };
  function checkpoint() {
    history = history.slice(0, historyIndex + 1);
    history.push(strokes.slice());
    if (history.length > 100) history.shift();
    historyIndex = history.length - 1;
  }
  const status = (text: string) => { if (note) note.textContent = [text,...voiceWarnings].join(' '); };
  const hint = () => status(tool === 'select'
    ? `Drag to move · ⌘/Ctrl-click selects several · ${talkHint().replace(/^h/, 'H')} to dictate about selected marks`
    : 'Draw while speaking, or Select marks before dictating · Esc discards draft');
  function select(ids: Iterable<string>) {
    const live = new Set(strokes.map(s => s.id));
    const next = new Set([...ids].filter(id => live.has(id)));
    if (next.size === selected.size && [...next].every(id => selected.has(id))) return;
    selected = next;
    selections.push({ at:now(), strokeIds:[...selected] });
  }
  function changed() {
    select(selected);
    speech.reconcile(strokes, selections);
    voiceWarnings = speech.exportNotes(strokes).warnings;
    render(); hint();
  }
  function chooseTool(next: EditorTool) {
    if (busy || pending || drag) return;
    tool = next;
    if (tool !== 'select') select([]);
    render(); hint();
  }
  function escapeDrawing() {
    if (!pickers?.close(true)) o.requestMode(false);
  }
  function render(updatePanel = true) {
    if (ink) ink.innerHTML = drawingSvg(pending ? [...strokes, pending] : strokes, viewport.width, viewport.height);
    if (selectionInk) {
      const box = selectionBounds(strokes, selected);
      selectionInk.innerHTML = box ? `<svg viewBox="0 0 ${viewport.width} ${viewport.height}" aria-hidden="true"><rect x="${box.left-5}" y="${box.top-5}" width="${box.width+10}" height="${box.height+10}" rx="4" fill="none" stroke="var(--ui-accent)" stroke-width="1.5" stroke-dasharray="5 3" vector-effect="non-scaling-stroke"/></svg>` : '';
    }
    if (shapeTip && !pending) shapeTip.hidden = true;
    if (stage) { stage.dataset.select = String(tool === 'select'); stage.dataset.dragging = String(!!drag); }
    for (const [name, button] of buttons) {
      if (['select','pen','arrow','rectangle','ellipse'].includes(name)) button.setAttribute('aria-pressed', String(name === tool));
      button.disabled = busy || !!pending || !!drag || (name === 'undo' ? historyIndex === 0 : name === 'delete' || name === 'clear' ? !strokes.length : name === 'redo' ? historyIndex === history.length - 1 : false);
    }
    pickers?.setDisabled(busy || !!pending || !!drag);
    if (form) { form.root.inert = busy; form.field.readOnly = busy; }
    if (speechPanel) {
      speechPanel.root.inert = busy || !!pending || !!drag;
      if (updatePanel) speechPanel.render();
    }
  }
  function layout() {
    if (!stage) return;
    const scale = Math.min(innerWidth / viewport.width, innerHeight / viewport.height);
    Object.assign(stage.style, { width: `${viewport.width * scale}px`, height: `${viewport.height * scale}px`, left: `${(innerWidth - viewport.width * scale) / 2}px`, top: `${(innerHeight - viewport.height * scale) / 2}px` });
  }
  const point = (e: PointerEvent): DrawingPoint => {
    const r = stage!.getBoundingClientRect();
    return { x: Math.max(0, Math.min(viewport.width, (e.clientX - r.left) * viewport.width / r.width)), y: Math.max(0, Math.min(viewport.height, (e.clientY - r.top) * viewport.height / r.height)) };
  };
  // Ctrl turns a box into a square and an ellipse into a circle, kept inside the captured viewport.
  let shapeEnd: DrawingPoint | null = null;
  function shapeTo(end: DrawingPoint, even: boolean) {
    if (!pending || pending.tool === 'pen' || pending.tool === 'arrow') return;
    shapeEnd = end;
    const a = pending.points[0]!, dx = end.x - a.x, dy = end.y - a.y;
    showShapeTip(even);
    if (!even) { pending.points[1] = end; return; }
    const side = Math.min(Math.max(Math.abs(dx), Math.abs(dy)), dx < 0 ? a.x : viewport.width - a.x, dy < 0 ? a.y : viewport.height - a.y);
    pending.points[1] = { x: a.x + (dx < 0 ? -side : side), y: a.y + (dy < 0 ? -side : side) };
  }
  // A label beside the pointer while a box or ellipse is drawn, flipped to stay inside the stage.
  function showShapeTip(even: boolean) {
    if (!shapeTip || !stage || !pending || !shapeEnd) return;
    const shape = pending.tool === 'rectangle' ? 'square' : 'circle';
    shapeTip.textContent = even ? shape[0]!.toUpperCase() + shape.slice(1) : `Ctrl: ${shape}`;
    shapeTip.hidden = false;
    const r = stage.getBoundingClientRect(), x = shapeEnd.x * r.width / viewport.width, y = shapeEnd.y * r.height / viewport.height;
    const { offsetWidth: w, offsetHeight: h } = shapeTip;
    shapeTip.style.left = `${x + 14 + w > r.width ? x - 14 - w : x + 14}px`;
    shapeTip.style.top = `${y + 14 + h > r.height ? y - 14 - h : y + 14}px`;
  }
  function selectedTargets(): CursorSample[] {
    const selected = new Map<string, CursorSample>();
    for (const stroke of strokes) {
      // Both arrow endpoints matter for requests such as "move this here".
      const points = stroke.points;
      // Enclosing shapes select the meaningful elements they surround, in addition to hits on their edges.
      const a = stroke.points[0]!, b = stroke.points.at(-1)!;
      if (stroke.tool === 'rectangle' || stroke.tool === 'ellipse') {
        for (const t of targets) {
          const x = t.rect.x + t.rect.width / 2, y = t.rect.y + t.rect.height / 2;
          if (x >= Math.min(a.x,b.x) && x <= Math.max(a.x,b.x) && y >= Math.min(a.y,b.y) && y <= Math.max(a.y,b.y)) selected.set(t.sample.elementPath!, t.sample);
        }
      }
      for (const p of points) {
        const hit = targets.filter(t => p.x >= t.rect.left && p.x <= t.rect.right && p.y >= t.rect.top && p.y <= t.rect.bottom).sort((a,b) => a.rect.width*a.rect.height-b.rect.width*b.rect.height)[0];
        if (hit) selected.set(hit.sample.elementPath!, hit.sample);
      }
    }
    return [...selected.values()].slice(0, MAX_DRAWING_TARGETS);
  }
  async function submit(text: string) {
    if (busy || o.forms.state().recording || o.forms.state().transcribing) { status('Finish dictating before sending.'); return; }
    if (pending || drag) { status('Finish the current gesture before sending.'); return; }
    if (!strokes.length) { status('Add a mark to send your drawing.'); return; }
    const token = generation;
    const voice = speech.exportNotes(strokes);
    voiceWarnings = voice.warnings;
    const marksSvg = drawingSvg(strokes, viewport.width, viewport.height);
    busy = true; render(); status('Preparing drawing…');
    try {
      const source = await loadImage(image);
      const marks = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(marksSvg)}`);
      const scale = Math.min(1, 1600 / Math.max(viewport.width, viewport.height));
      const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(viewport.width * scale)); canvas.height = Math.max(1, Math.round(viewport.height * scale));
      const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('Image export unavailable');
      ctx.drawImage(source, 0, 0, canvas.width, canvas.height); ctx.drawImage(marks, 0, 0, canvas.width, canvas.height);
      let dataUrl = canvas.toDataURL('image/jpeg', .85);
      if (dataUrl.length > MAX_DRAWING_IMAGE_CHARS) dataUrl = canvas.toDataURL('image/jpeg', .6);
      if (dataUrl.length > MAX_DRAWING_IMAGE_CHARS) throw new Error('Drawing image is too large. Try a smaller viewport.');
      if (token !== generation || !on) return;
      const targetSamples = selectedTargets();
      const annotation: DrawingAnnotation = { version:1, id:uid(), pageUrl, createdAt, viewport, strokes:structuredClone(strokes), targetSamples, ...(voice.notes.length ? {voiceNotes:voice.notes} : {}), image:{ dataUrl, width:canvas.width, height:canvas.height } };
      const center = drawingAnchor({ ...annotation, targetSamples: [] })?.point;
      if (center) annotation.markerSample = drawingMarkerSample(targets.map(t => t.sample), center);
      o.send(text, targetSamples.length === 1 ? targetSamples[0]! : null, annotation);
      clearDraft(); o.requestMode(false);
    } catch (err) {
      if (token === generation && on) status(err instanceof Error ? err.message : 'Could not prepare drawing. Please retry.');
    }
    finally { if (token === generation) { busy = false; render(); } }
  }
  function hide() {
    on = false; generation++; pending = null; drag = null;
    releasePointer();
    pickers?.close();
    if (root) root.hidden = true;
    form?.setOpen(false);
    form?.field.blur();
  }
  function clearDraft() {
    hide(); form?.destroy(); form = null; root?.remove(); root = null; stage = null; ink = null; selectionInk = null; shapeTip = null; note = null; image = ''; strokes = []; history = [[]]; historyIndex = 0; targets = []; busy = false; buttons.clear(); commands.clear();
    pickers?.destroy(); pickers = null;
    speechPanel?.destroy(); speechPanel = null; speech.clear(); fieldText = ''; voiceWarnings = [];
    selected.clear(); selections = []; nextLabel = 1;
  }
  function releasePointer() {
    const releasedId = pointerId;
    // Clear our gesture ownership before releasePointerCapture can dispatch lifecycle events.
    pointerId = null;
    if (releasedId !== null && stage?.hasPointerCapture(releasedId)) stage.releasePointerCapture(releasedId);
  }
  function commitGesture() {
    if (drag) { if (strokes !== drag.strokes) checkpoint(); drag = null; }
    if (pending) { pending.endedAt = now(); strokes = [...strokes,pending]; pending = null; shapeEnd = null; checkpoint(); }
    releasePointer(); changed();
  }
  function cancelGesture() {
    if (drag) strokes = drag.strokes;
    drag = null; pending = null; releasePointer(); changed();
  }
  function shortcuts(e: KeyboardEvent) {
    if (e.defaultPrevented) return;
    if (e.key === 'Escape') { e.preventDefault(); escapeDrawing(); return; }
    const target = e.target as Node | null;
    if (target === form?.field || pickers?.contains(target) || (target && speechPanel?.root.contains(target)) || busy || pending || drag || e.isComposing) { holdPage(e); return; }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); run(e.shiftKey ? 'redo' : 'undo'); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); run('delete'); }
    else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a' && tool === 'select') { e.preventDefault(); select(strokes.map(s => s.id)); render(); }
    else if (tool === 'select' && selected.size && ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key) && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
      e.preventDefault();
      const step = e.altKey ? 10 : 1;
      const moved = translateDrawingSelection(strokes, selected, e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0, e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0, viewport.width, viewport.height);
      if (moved !== strokes) { strokes = moved; checkpoint(); render(); }
    }
    else holdPage(e);
  }
  // Keep the captured page still: keys that would scroll it do nothing unless a field or button here uses them.
  function holdPage(e: KeyboardEvent) {
    const t = e.target as HTMLElement | null;
    if (!SCROLL_KEYS.has(e.key) || t?.closest?.('input,textarea,select,[contenteditable]') || (e.key === ' ' && t?.closest?.('button'))) return;
    e.preventDefault();
  }
  function mount() {
    root = document.createElement('div'); root.className = 'draw-overlay';
    root.setAttribute('role','region'); root.setAttribute('aria-label','Drawing feedback');
    stage = document.createElement('div'); stage.className = 'draw-stage'; stage.tabIndex = 0; stage.setAttribute('aria-label','Drawing canvas. Use Select to move marks.');
    const backdrop = document.createElement('img'); backdrop.src = image; backdrop.alt = 'Captured page'; backdrop.draggable = false;
    ink = document.createElement('div'); ink.className = 'draw-ink';
    selectionInk = document.createElement('div'); selectionInk.className = 'draw-selection';
    shapeTip = document.createElement('div'); shapeTip.className = 'draw-shape-tip'; shapeTip.hidden = true; shapeTip.setAttribute('aria-hidden','true');
    stage.append(backdrop,ink,selectionInk,shapeTip);
    const controls = document.createElement('div'); controls.className = 'draw-controls';
    const toolbar = document.createElement('div'); toolbar.className = 'draw-tools'; toolbar.setAttribute('role','toolbar'); toolbar.setAttribute('aria-label','Drawing tools');
    pickers = createDrawingPickers(appearance, value => { appearance = value; });
    toolbar.append(...pickers.elements);
    const actions: [string,string,()=>void][] = [
      ['select','Select',()=>chooseTool('select')],
      ...(['pen','arrow','rectangle','ellipse'] as DrawingTool[]).map(t => [t, {pen:'Pen',arrow:'↗ Arrow',rectangle:'▢ Box',ellipse:'◯ Ellipse'}[t], () => chooseTool(t)] as [string,string,()=>void]),
      ['undo','↶',()=>{ if(historyIndex > 0) strokes=history[--historyIndex]!.slice(); changed(); }],
      ['redo','↷',()=>{ if(historyIndex < history.length-1) strokes=history[++historyIndex]!.slice(); changed(); }],
      ['delete','⌫',()=>{ const ids = selected.size ? selected : new Set([strokes.at(-1)?.id]); strokes=strokes.filter(s=>!ids.has(s.id)); checkpoint(); changed(); }],
      ['clear','Clear',()=>{ strokes=[]; checkpoint(); changed(); }],
      ['close','×',()=>o.requestMode(false)],
    ];
    for (const [name,label,action] of actions) { const b=document.createElement('button'); b.type='button'; b.textContent=label; b.title=name === 'close' ? 'Back to browsing (Esc); discard draft' : name; b.setAttribute('aria-label', name); if(name==='close') b.className='draw-close'; b.onclick=action; toolbar.append(b); buttons.set(name,b); commands.set(name,action); }
    buttons.get('select')!.title = 'Select and drag marks; ⌘/Ctrl-click to select several';
    buttons.get('rectangle')!.title = 'Box; hold Ctrl for a square';
    buttons.get('ellipse')!.title = 'Ellipse; hold Ctrl for a circle';
    buttons.get('delete')!.title = 'Delete selected marks, or the latest mark';
    form = o.forms.create({
      placeholder:'Describe the change…', submit: text => void submit(text), escape:escapeDrawing,
      activateOnCreate:true, keepDictationOnBlur:true, focusAfterDictation:false,
      onDictation(text, transcript, range, previousText) {
        const currentText = form!.value();
        voiceWarnings = speech.insert({previousText,currentText,...range,text,transcript,strokes:pending ? [...strokes,pending] : strokes,selections});
        fieldText = currentText;
        speechPanel?.render(); hint();
      },
    });
    form.field.addEventListener('input',()=>{ const current=form!.value(); speech.edit(fieldText,current); fieldText=current; voiceWarnings=speech.exportNotes(strokes).warnings; speechPanel?.render(); hint(); });
    speechPanel = createDrawingSpeechPanel({
      entries:()=>speech.view(), strokes:()=>strokes, selection:()=>[...selected],
      setLinks(id,ids) { if(busy || pending || drag) return; speech.setLinks(id,ids); speechPanel?.render(); },
      selectMarks(ids) { if(busy || pending || drag) return; tool='select'; select(ids); render(); hint(); stage?.focus({preventScroll:true}); },
      focusText(start,end) { if(busy || !form) return; form.focus(); form.field.setSelectionRange(start,end); form.field.dispatchEvent(new Event('select')); },
    });
    note=document.createElement('div'); note.className='draw-note'; note.setAttribute('role','status'); hint();
    controls.append(toolbar,form.root,speechPanel.root,note); root.append(stage,controls); o.layer.append(root); o.attach();
    begin = e => {
      e.preventDefault(); if(e.button !== 0 || busy || pointerId !== null) return;
      pickers?.close(); stage!.focus({preventScroll:true});
      const p=point(e);
      if(tool === 'select') {
        const tolerance=6*viewport.width/stage!.getBoundingClientRect().width;
        const hit=hitDrawingStroke(strokes,p,tolerance,viewport);
        if(!hit) { select([]); render(); hint(); return; }
        if(e.metaKey || e.ctrlKey) {
          const ids=new Set(selected);
          if(ids.has(hit.id)) ids.delete(hit.id); else ids.add(hit.id);
          select(ids);
        } else if(!selected.has(hit.id)) select([hit.id]);
        if(selected.has(hit.id)) {
          pointerId=e.pointerId; stage!.setPointerCapture(e.pointerId);
          drag={pointerId:e.pointerId,origin:p,strokes,ids:new Set(selected)};
        }
        render(); hint(); return;
      }
      if(strokes.length >= MAX_DRAWING_STROKES || strokes.reduce((n,s)=>n+s.points.length,0) >= MAX_DRAWING_POINTS-2) { status('Drawing limit reached. Clear or remove a mark to continue.'); return; }
      pointerId=e.pointerId; stage!.setPointerCapture(e.pointerId);
      const at=now(); shapeEnd=null; pending={id:uid(),label:nextLabel++,startedAt:at,endedAt:at,tool,...appearance,points:[p,{...p}]}; render();
    };
    move = e => {
      if(e.pointerId !== pointerId) return;
      // If release happened outside the window, retain the last position instead of following
      // the pointer when it re-enters with no button held.
      if(e.type === 'pointermove' && !(e.buttons & 1)) { commitGesture(); return; }
      const p=point(e);
      if(drag) {
        strokes=translateDrawingSelection(drag.strokes,drag.ids,p.x-drag.origin.x,p.y-drag.origin.y,viewport.width,viewport.height);
        render(false); return;
      }
      if(!pending) return;
      pending.endedAt=now();
      if(pending.tool === 'pen') { if (pending.points.length + strokes.reduce((n,s)=>n+s.points.length,0) < MAX_DRAWING_POINTS) { const last=pending.points.at(-1)!; if(Math.hypot(last.x-p.x,last.y-p.y)>1) pending.points.push(p); } }
      else if(pending.tool === 'arrow') pending.points[1]=p;
      else shapeTo(p,e.ctrlKey);
      render(false);
    };
    finish = e => {
      if(e.pointerId !== pointerId) return;
      move(e);
      commitGesture();
    };
    stage.addEventListener('pointerdown',begin);
    stage.addEventListener('pointermove',move);
    stage.addEventListener('pointerup',finish);
    stage.addEventListener('pointercancel',e=>{ if(e.pointerId===pointerId) cancelGesture(); });
    // Capture loss is not cancellation. Window-level routing keeps ownership until pointerup
    // or pointercancel, including when Chromium releases capture around a fast mouse release.
    root.addEventListener('pointerdown', e => { if (!pickers?.contains(e.target as Node)) pickers?.close(); }, true);
    // Stop events at the shadow boundary, after the form's typing/Shift handlers have run.
    for(const name of ['pointerdown','pointerup','pointermove','click','dblclick','contextmenu','keydown','keyup','wheel'] as const) root.addEventListener(name,e=>{e.stopPropagation(); if(name==='contextmenu')e.preventDefault();},{passive:false});
    root.addEventListener('keydown',shortcuts);
    render(); layout();
  }
  async function setMode(next: boolean) {
    if(!next) { clearDraft(); return; }
    if(on) return;
    on=true; const token=++generation;
    try {
      viewport={width:innerWidth,height:innerHeight,scrollX,scrollY}; pageUrl=location.href;createdAt=now(); selections=[{at:createdAt,strokeIds:[]}];
      targets=o.snapshot();
      const captured=await o.capture();
      if(token !== generation || !on) return;
      if (viewport.width !== innerWidth || viewport.height !== innerHeight || pageUrl !== location.href || viewport.scrollX !== scrollX || viewport.scrollY !== scrollY) throw new Error('Page moved during capture. Enter Draw again.');
      image=captured; mount();
    } catch(err) {
      if(token !== generation || !on) return;
      clearDraft();o.requestMode(false);
      const alert = document.createElement('div');
      alert.setAttribute('role','alert');
      alert.style.cssText='position:fixed;bottom:24px;left:50%;transform:translateX(-50%);max-width:calc(100vw - 48px);padding:12px 16px;border-radius:12px;background:var(--ui-panel);color:var(--ui-text);border:1px solid var(--ui-line);box-shadow:0 8px 30px #0004;pointer-events:auto;font:13px/1.4 system-ui';
      alert.textContent=err instanceof Error ? err.message : 'Could not capture the page. Enter Draw again to retry.';
      o.layer.append(alert);o.attach();setTimeout(()=>alert.remove(),6000);
      console.error('Drawing capture failed',err);
    }
  }
  let begin: (e: PointerEvent) => void = () => {}, move: (e: PointerEvent) => void = () => {}, finish: (e: PointerEvent) => void = () => {};
  // Handle canvas input at the earliest capture listener, before the visited application's handlers.
  const hitStage = (e: MouseEvent) => {
    if (!on || !root || !stage) return false;
    const scope = o.layer.getRootNode() as ShadowRoot | Document;
    const hit = scope.elementFromPoint(e.clientX,e.clientY);
    return !!hit && (hit === stage || stage.contains(hit));
  };
  function handlePointer(e: PointerEvent): boolean {
    if (!on || (pointerId === null && !hitStage(e))) return false;
    e.preventDefault(); e.stopImmediatePropagation();
    if(e.type==='pointerdown') begin(e);
    else if(e.type==='pointermove') move(e);
    else if(e.type==='pointerup') finish(e);
    else if(e.pointerId===pointerId) cancelGesture();
    return true;
  }
  for (const name of ['pointerdown','pointermove','pointerup','pointercancel'] as const) window.addEventListener(name, handlePointer, true);
  for (const name of ['mousedown','mouseup','mousemove','click','dblclick','auxclick','contextmenu'] as const) window.addEventListener(name,e=>{
    if(e.isTrusted && hitStage(e)) {e.preventDefault();e.stopImmediatePropagation();}
  },{capture:true,passive:false});
  // The page must not scroll under the screenshot; a wheel only scrolls an overlay control (note field, speech panel) that can still move.
  const overlayScrolls = (e: WheelEvent) => {
    const scope = o.layer.getRootNode() as ShadowRoot | Document;
    for (let el = scope.elementFromPoint(e.clientX,e.clientY); el && root?.contains(el); el = el.parentElement) {
      const css = getComputedStyle(el);
      if (e.deltaY && /auto|scroll/.test(css.overflowY) && (e.deltaY < 0 ? el.scrollTop > 0 : el.scrollTop + el.clientHeight < el.scrollHeight - 1)) return true;
      if (e.deltaX && /auto|scroll/.test(css.overflowX) && (e.deltaX < 0 ? el.scrollLeft > 0 : el.scrollLeft + el.clientWidth < el.scrollWidth - 1)) return true;
    }
    return false;
  };
  window.addEventListener('wheel',e=>{
    if(!on || !e.isTrusted) return;
    if(hitStage(e)) e.stopImmediatePropagation();
    if(!overlayScrolls(e)) e.preventDefault();
  },{capture:true,passive:false});
  window.addEventListener('keydown',e=>{
    if(!on || drawingPreviewOpen()) return;
    const scope=o.layer.getRootNode() as ShadowRoot | Document;
    const typing=scope.activeElement === form?.field;
    if(e.key==='Escape') {e.preventDefault();e.stopImmediatePropagation();escapeDrawing();return;}
    if(typing || pickers?.contains(scope.activeElement) || (scope.activeElement && speechPanel?.root.contains(scope.activeElement))) return;
    // Let native button activation and Tab reach the focused control in the closed shadow root.
    if(scope.activeElement && root?.contains(scope.activeElement)) return;
    e.stopImmediatePropagation(); shortcuts(e);
  },true);
  // Pressing or releasing Ctrl mid-drag reshapes the box without waiting for the pointer to move.
  for (const name of ['keydown','keyup'] as const) window.addEventListener(name,e=>{
    if(!on || e.key !== 'Control' || !pending || !shapeEnd) return;
    shapeTo(shapeEnd,name === 'keydown'); render(false);
  },true);
  window.addEventListener('resize',layout);
  window.addEventListener('blur',()=>{ if(pointerId !== null) cancelGesture(); });
  window.addEventListener('pagehide',clearDraft);
  return {setMode, clear:clearDraft, active:()=>on, handlePointer};
}
