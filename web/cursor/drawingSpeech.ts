import type { Word } from '../../shared/protocol.ts';
import { MAX_DRAWING_VOICE_NOTES, MAX_DRAWING_PHRASES, MAX_DRAWING_VOICE_TEXT, type DrawingSpeechPhrase, type DrawingVoiceNote } from '../../shared/annotations.ts';

export interface SpeechStroke { id: string; startedAt?: number; endedAt?: number }
export interface DrawingSelectionChange { at: number; strokeIds: string[] }
export interface DrawingTranscript { id: string; startedAt: number; endedAt: number; words: Word[] }
export interface DrawingSpeechInsertion {
  previousText: string;
  currentText: string;
  /** The inserted transcript's range in currentText, excluding caret padding. */
  start: number;
  end: number;
  text: string;
  transcript?: DrawingTranscript;
  strokes: readonly SpeechStroke[];
  selections: readonly DrawingSelectionChange[];
}
export interface DrawingPhraseView {
  id: string;
  noteId: string;
  noteNumber: number;
  text: string;
  start: number;
  end: number;
  source: DrawingSpeechPhrase['source'];
  timing: DrawingSpeechPhrase['timing'];
  strokeIds: string[];
}
interface Phrase extends DrawingPhraseView { startedAt: number; endedAt: number; manual: boolean; timed: boolean; words: Aligned[] }
interface Note { id: string; startedAt: number; endedAt: number; phrases: Phrase[] }
interface Aligned { start: number; end: number; startedAt: number; endedAt: number }
const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const unique = (ids: readonly string[]) => [...new Set(ids.filter(Boolean))];
const signature = (ids: readonly string[]) => unique(ids).sort().join('\0');
const normalized = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const uid = () => `phrase-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const validStrokeTime = (s: SpeechStroke) => finite(s.startedAt) && finite(s.endedAt) && s.startedAt >= 0 && s.endedAt >= s.startedAt;

/** Keep offsets into the actual inserted text; ASR punctuation and casing need not equal its word records. */
function alignWords(text: string, words: readonly Word[], origin: number, clipEnd: number): Aligned[] {
  const tokens = [...text.matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)].map(m => ({text:normalized(m[0]), start:m.index, end:m.index+m[0].length}));
  const result: Aligned[] = [];
  let cursor = 0, previousStart = -1;
  for (const word of words) {
    if (!word || typeof word.text !== 'string' || !finite(word.start) || !finite(word.end) || word.end < word.start || word.start < 0 || word.start < previousStart) continue;
    const startedAt=origin+word.start*1000, endedAt=origin+word.end*1000;
    if(!finite(startedAt) || !finite(endedAt) || startedAt>clipEnd || endedAt>clipEnd+250) continue;
    previousStart=word.start;
    const wanted = normalized(word.text);
    if (!wanted) continue;
    let found = false;
    for (let i=cursor; i<tokens.length; i++) {
      let joined = '';
      for (let j=i; j<tokens.length && joined.length < wanted.length; j++) {
        joined += tokens[j]!.text;
        if (joined === wanted) {
          result.push({start:tokens[i]!.start,end:tokens[j]!.end,startedAt,endedAt:Math.min(endedAt,clipEnd)});
          cursor=j+1;found=true;break;
        }
      }
      if(found) break;
    }
  }
  return result;
}
function selectedAt(history: readonly DrawingSelectionChange[], time: number): string[] {
  let latest: DrawingSelectionChange | undefined;
  for (const entry of history) if(finite(entry.at) && entry.at <= time && (!latest || entry.at >= latest.at)) latest=entry;
  return unique(latest?.strokeIds ?? []);
}
function overlapping(strokes: readonly SpeechStroke[], start: number, end: number): string[] {
  return unique(strokes.filter(s => validStrokeTime(s) && s.startedAt! <= end && s.endedAt! >= start).map(s=>s.id));
}
/** Pure transcript bookkeeping. Raw mark references survive deletion so a later Undo restores their links. */
export function createDrawingSpeech() {
  let notes: Note[] = [];
  let fieldText = '';
  let strokes: readonly SpeechStroke[] = [];
  let selections: readonly DrawingSelectionChange[] = [];
  const all = () => notes.flatMap(n=>n.phrases);
  const limitWarnings = () => {
    const warnings: string[] = [];
    if(notes.length > MAX_DRAWING_VOICE_NOTES) warnings.push(`Only the first ${MAX_DRAWING_VOICE_NOTES} voice notes can be attached; all request text is retained.`);
    if(all().length > MAX_DRAWING_PHRASES) warnings.push(`Only ${MAX_DRAWING_PHRASES} voice phrases can be attached; all request text is retained.`);
    if(all().reduce((n,p)=>n+p.text.length,0) > MAX_DRAWING_VOICE_TEXT) warnings.push(`Voice attachment text exceeds ${MAX_DRAWING_VOICE_TEXT} characters; all request text is retained.`);
    return warnings;
  };
  function link(phrase: Phrase) {
    if(phrase.manual || phrase.strokeIds.length && phrase.source!=='unlinked') return;
    if(phrase.strokeIds.some(id=>!strokes.some(s=>s.id===id))) return;
    let explicit = phrase.timed ? selectedAt(selections,(phrase.startedAt+phrase.endedAt)/2) : selectedAt(selections,phrase.startedAt);
    if(phrase.timing==='clip' && phrase.timed) {
      const initial=selectedAt(selections,phrase.startedAt);
      if(signature(initial)!==signature(selectedAt(selections,phrase.endedAt)) || selections.some(s=>s.at>phrase.startedAt && s.at<phrase.endedAt && signature(s.strokeIds)!==signature(initial))) explicit=[];
    }
    if(explicit.length) { phrase.strokeIds=explicit;phrase.source='selected';return; }
    if(!phrase.timed) {phrase.strokeIds=[];phrase.source='unlinked';return;}
    const hits=overlapping(strokes,phrase.startedAt,phrase.endedAt);
    // A clip without word timing may establish one unambiguous overlap, never a guessed recent mark.
    if(hits.length === 1) {phrase.strokeIds=hits;phrase.source='automatic';return;}
    if(!hits.length && phrase.timing === 'word') {
      const recent=strokes.filter(s=>validStrokeTime(s) && s.endedAt! < phrase.startedAt && phrase.startedAt-s.endedAt! <= 1800);
      if(recent.length === 1) {phrase.strokeIds=[recent[0]!.id];phrase.source='automatic';return;}
    }
    phrase.strokeIds=[];phrase.source='unlinked';
  }
  function activityBoundaries(words: readonly Aligned[]): number[] {
    const cuts: number[]=[];
    let previousSelection='', previousActivity='';
    for(let i=0;i<words.length;i++) {
      const word=words[i]!;
      const selected=signature(selectedAt(selections,(word.startedAt+word.endedAt)/2));
      const activity=selected ? '' : signature(overlapping(strokes,word.startedAt,word.endedAt));
      const selectionChanged=i>0 && selected!==previousSelection;
      if(selectionChanged || activity && previousActivity && activity!==previousActivity) cuts.push(i);
      if(selectionChanged) previousActivity='';
      if(activity) previousActivity=activity;
      previousSelection=selected;
    }
    // Empty activity between words does not divide one gesture into before/during/after fragments.
    return cuts;
  }
  function refine(phrase: Phrase): Phrase[] {
    if(phrase.manual || phrase.source!=='unlinked' || phrase.words.length<2 || phrase.strokeIds.some(id=>!strokes.some(s=>s.id===id))) return [phrase];
    const cuts=activityBoundaries(phrase.words);
    if(!cuts.length) return [phrase];
    const parts: Phrase[]=[];
    let first=0,offset=phrase.start;
    for(const last of [...cuts,phrase.words.length]) {
      const end=last<phrase.words.length ? phrase.words[last]!.start : phrase.end;
      const raw=fieldText.slice(offset,end),text=raw.trim();
      if(text) {
        const start=offset+raw.length-raw.trimStart().length;
        const words=phrase.words.slice(first,last);
        parts.push({...phrase,id:parts.length ? uid() : phrase.id,text,start,end:start+text.length,startedAt:words[0]!.startedAt,endedAt:words.at(-1)!.endedAt,strokeIds:[],source:'unlinked',words});
      }
      first=last;offset=end;
    }
    return parts;
  }
  function reconcile(nextStrokes: readonly SpeechStroke[], nextSelections: readonly DrawingSelectionChange[] = selections) {
    strokes=nextStrokes;selections=nextSelections;
    for(const note of notes) note.phrases=note.phrases.flatMap(refine);
    for(const phrase of all()) link(phrase);
  }
  function edit(previousText: string, currentText: string) {
    if(previousText === currentText) {fieldText=currentText;return;}
    let start=0;
    while(start<previousText.length && start<currentText.length && previousText[start]===currentText[start]) start++;
    let beforeEnd=previousText.length, afterEnd=currentText.length;
    while(beforeEnd>start && afterEnd>start && previousText[beforeEnd-1]===currentText[afterEnd-1]) {beforeEnd--;afterEnd--;}
    const delta=afterEnd-beforeEnd;
    // A replacement crossing several phrases belongs to one range, rather than duplicating its text in every clip.
    const replacementOwner=beforeEnd>start ? all().filter(p=>p.end>start && p.start<beforeEnd).sort((a,b)=>a.start-b.start)[0] : undefined;
    for(const phrase of all()) {
      const a=phrase.start,b=phrase.end;
      if(start<phrase.end && beforeEnd>phrase.start || start===beforeEnd && start>phrase.start && start<phrase.end) phrase.words=[];
      else if(start<=phrase.start) phrase.words=phrase.words.map(w=>({...w,start:w.start+delta,end:w.end+delta}));
      if(start===beforeEnd) {
        // Typing at a boundary belongs to adjacent request text; typing inside a phrase edits its description.
        if(a>=start) {phrase.start+=delta;phrase.end+=delta;}
        else if(b>start) phrase.end+=delta;
      } else if(b<=start) { /* precedes edit */ }
      else if(a>=beforeEnd) {phrase.start+=delta;phrase.end+=delta;}
      else if(phrase===replacementOwner) {
        phrase.start=a<start ? a : start;
        phrase.end=b>beforeEnd ? b+delta : afterEnd;
      } else {
        const leftSurvives=a<start,rightSurvives=b>beforeEnd;
        phrase.start=leftSurvives ? a : afterEnd;
        phrase.end=rightSurvives ? b+delta : leftSurvives ? start : phrase.start;
      }
      phrase.start=Math.max(0,Math.min(currentText.length,phrase.start));
      phrase.end=Math.max(phrase.start,Math.min(currentText.length,phrase.end));
      // Trimming the tracked range avoids preserving empty phrases after deletions.
      const raw=currentText.slice(phrase.start,phrase.end);
      const leading=raw.length-raw.trimStart().length;
      phrase.start+=leading;phrase.end=phrase.start+raw.trim().length;
      phrase.text=currentText.slice(phrase.start,phrase.end);
    }
    for(const note of notes) note.phrases=note.phrases.filter(p=>p.text.length>0);
    notes=notes.filter(n=>n.phrases.length>0);
    fieldText=currentText;
  }
  function insert(input: DrawingSpeechInsertion): string[] {
    edit(input.previousText,input.currentText);
    strokes=input.strokes;selections=input.selections;
    if(!Number.isInteger(input.start) || !Number.isInteger(input.end) || input.start<0 || input.end<input.start || input.end>input.currentText.length) return [...limitWarnings(),'Voice attachment range is unavailable; the request text is retained.'];
    const start=Math.max(0,Math.min(input.currentText.length,input.start));
    const end=Math.max(start,Math.min(input.currentText.length,input.end));
    const text=input.currentText.slice(start,end);
    if(!text.trim()) return limitWarnings();
    // A dictated replacement belongs to its new clip. Preserve the older phrase's surviving sides.
    for(const existing of notes) existing.phrases=existing.phrases.flatMap(p=>{
      if(p.end<=start || p.start>=end) return [p];
      const fragments: Phrase[]=[];
      for(const [a,b] of [[p.start,Math.min(p.end,start)],[Math.max(p.start,end),p.end]] as [number,number][]) {
        const raw=input.currentText.slice(a,b),text=raw.trim();
        if(b<=a || !text) continue;
        const first=a+raw.length-raw.trimStart().length;
        fragments.push({...p,id:fragments.length ? uid() : p.id,start:first,end:first+text.length,text,words:p.words.filter(w=>w.start>=first && w.end<=first+text.length)});
      }
      return fragments;
    });
    notes=notes.filter(n=>n.phrases.length);
    const meta=input.transcript;
    const timed=!!meta && finite(meta.startedAt) && finite(meta.endedAt) && meta.startedAt>=0 && meta.endedAt>=meta.startedAt;
    const at=timed ? meta!.startedAt : Date.now();
    const until=timed ? meta!.endedAt : at;
    const noteId=typeof meta?.id==='string' && meta.id.length>0 && meta.id.length<=128 ? meta.id : uid();
    let note=notes.find(n=>n.id===noteId);
    if(!note) {note={id:noteId,startedAt:at,endedAt:until,phrases:[]};notes.push(note);}
    else {note.startedAt=Math.min(note.startedAt,at);note.endedAt=Math.max(note.endedAt,until);}
    const candidates=timed ? alignWords(text,Array.isArray(meta!.words) ? meta!.words : [],at,until) : [];
    const matched=candidates.reduce((n,w)=>n+normalized(text.slice(w.start,w.end)).length,0);
    // A stray coincidentally matching word is not enough to time an otherwise unmatched transcript.
    const aligned=matched>=normalized(text).length*.6 ? candidates : [];
    const pieces: {start:number;end:number;startedAt:number;endedAt:number;timing:'word'|'clip'}[]=[];
    if(aligned.length) {
      let first=0,offset=0;
      const activityCuts=new Set(activityBoundaries(aligned));
      for(let i=1;i<=aligned.length;i++) {
        const previous=aligned[i-1]!,next=aligned[i];
        const boundary=!next || next.startedAt-previous.endedAt>650
          || /[.!?;\n]/.test(text.slice(previous.end,next.start))
          || activityCuts.has(i)
          || i-first>=22;
        if(boundary) {
          const cut=next ? next.start : text.length;
          pieces.push({start:offset,end:cut,startedAt:aligned[first]!.startedAt,endedAt:previous.endedAt,timing:'word'});
          first=i;offset=cut;
        }
      }
    } else {
      for(const match of text.matchAll(/[^.!?;\n]+(?:[.!?;]+|$)/g)) pieces.push({start:match.index,end:match.index+match[0].length,startedAt:at,endedAt:until,timing:'clip'});
      if(!pieces.length) pieces.push({start:0,end:text.length,startedAt:at,endedAt:until,timing:'clip'});
    }
    for(const piece of pieces) {
      const raw=text.slice(piece.start,piece.end),clean=raw.trim();
      if(!clean) continue;
      const position=start+piece.start+(raw.length-raw.trimStart().length);
      const phrase: Phrase={id:uid(),noteId,noteNumber:notes.indexOf(note)+1,text:clean,start:position,end:position+clean.length,startedAt:piece.startedAt,endedAt:piece.endedAt,timing:piece.timing,strokeIds:[],source:'unlinked',manual:false,timed,words:aligned.filter(w=>w.start>=piece.start && w.end<=piece.end).map(w=>({...w,start:w.start+start,end:w.end+start}))};
      link(phrase);note.phrases.push(phrase);
    }
    fieldText=input.currentText;
    return limitWarnings();
  }
  function setLinks(phraseId: string, strokeIds: readonly string[]) {
    const phrase=all().find(p=>p.id===phraseId);
    if(!phrase) return;
    phrase.manual=true;phrase.strokeIds=unique(strokeIds);phrase.source=phrase.strokeIds.length ? 'manual' : 'unlinked';
  }
  function view(currentStrokes?: readonly SpeechStroke[]): DrawingPhraseView[] {
    const ids=currentStrokes ? new Set(currentStrokes.map(s=>s.id)) : null;
    return notes.flatMap((note,index)=>note.phrases.map(p=>({id:p.id,noteId:note.id,noteNumber:index+1,text:p.text,start:p.start,end:p.end,source:p.source,timing:p.timing,strokeIds:ids ? p.strokeIds.filter(id=>ids.has(id)) : [...p.strokeIds]})));
  }
  function exportNotes(currentStrokes: readonly SpeechStroke[] = strokes): {notes: DrawingVoiceNote[]; warnings: string[]} {
    const ids=new Set(currentStrokes.map(s=>s.id));
    const exported: DrawingVoiceNote[]=[];
    let count=0,characters=0;
    for(const note of notes.slice(0,MAX_DRAWING_VOICE_NOTES)) {
      const phrases: DrawingSpeechPhrase[]=[];
      for(const p of note.phrases) {
        if(count>=MAX_DRAWING_PHRASES || characters+p.text.length>MAX_DRAWING_VOICE_TEXT) continue;
        const strokeIds=p.strokeIds.filter(id=>ids.has(id));
        phrases.push({id:p.id,text:p.text,startedAt:p.startedAt,endedAt:p.endedAt,strokeIds,source:strokeIds.length ? p.source : 'unlinked',timing:p.timing});
        count++;characters+=p.text.length;
      }
      if(phrases.length) exported.push({id:note.id,startedAt:note.startedAt,endedAt:note.endedAt,phrases});
    }
    return {notes:exported,warnings:limitWarnings()};
  }
  return {insert,edit,reconcile,setLinks,view,exportNotes,clear:()=>{notes=[];fieldText='';strokes=[];selections=[];}};
}
