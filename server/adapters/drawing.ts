import type { ImageBlockParam, TextBlockParam } from "@anthropic-ai/sdk/resources/messages";
import { DRAWING_COLORS, drawingStrokeColor, drawingStrokeStyle, drawingStrokeWidth, type DrawingAnnotation } from "../../shared/annotations.ts";

/** These serializers mirror the installed Codex app-server UserInput schema, pi RPC ImageContent,
 * OpenCode SDK FilePartInput, and Anthropic Messages content blocks. No image bytes enter prompt text. */
export function drawingImage(a: DrawingAnnotation): { mediaType: "image/png" | "image/jpeg"; data: string } {
  const comma = a.image.dataUrl.indexOf(",");
  return { mediaType: a.image.dataUrl.startsWith("data:image/jpeg;") ? "image/jpeg" : "image/png", data: a.image.dataUrl.slice(comma + 1) };
}

export function drawingContext(a: DrawingAnnotation): string {
  const round = (n: number) => Math.round(n);
  const strokes = a.strokes.map(s => {
    const xs = s.points.map(p => p.x), ys = s.points.map(p => p.y);
    const first = s.points[0]!, last = s.points.at(-1)!;
    const color = drawingStrokeColor(s), name = DRAWING_COLORS.find(c => c.value === color)?.name;
    const mark = s.label === undefined ? `Stroke ID ${JSON.stringify(s.id)}` : `Mark ${s.label} (stroke ID ${JSON.stringify(s.id)})`;
    const creation = s.startedAt === undefined && s.endedAt === undefined ? "creation time unavailable (legacy mark)"
      : `original creation interval ${s.startedAt ?? "unknown"}–${s.endedAt ?? "unknown"} epoch ms (unchanged by movement)`;
    return `${mark}, ${s.tool}, ${creation}: bounds (${round(Math.min(...xs))},${round(Math.min(...ys))})–(${round(Math.max(...xs))},${round(Math.max(...ys))}); color ${name ? `${name} ` : ""}${color}; ${drawingStrokeStyle(s)} stroke, ${drawingStrokeWidth(s)} px wide; ${s.points.length} points; from (${round(first.x)},${round(first.y)}) to (${round(last.x)},${round(last.y)})`;
  });
  const strokeById = new Map(a.strokes.map(s => [s.id, s]));
  const voice = (a.voiceNotes ?? []).map(note => {
    const phrases = note.phrases.map(phrase => {
      const refs = phrase.strokeIds.map(id => {
        const stroke = strokeById.get(id);
        return stroke?.label === undefined ? `stroke ID ${JSON.stringify(id)}` : `Mark ${stroke.label} (stroke ID ${JSON.stringify(id)})`;
      });
      const association = phrase.source === "automatic" ? "automatic: timing suggestion, not an explicit user association"
        : phrase.source === "selected" ? "selected: explicit association to marks selected by the user"
        : phrase.source === "manual" ? "manual: explicit association assigned by the user"
        : "unlinked: no association to a mark";
      const timing = phrase.timing === "word" ? "word: phrase-level word timestamps" : "clip: recording interval only; no word timing";
      return `  Phrase ID ${JSON.stringify(phrase.id)}, ${phrase.startedAt}–${phrase.endedAt} epoch ms; text ${JSON.stringify(phrase.text)}; linked marks: ${refs.length ? refs.join(", ") : "none"}; source ${association}; timing ${timing}.`;
    });
    return `Voice note ID ${JSON.stringify(note.id)}, ${note.startedAt}–${note.endedAt} epoch ms:\n${phrases.join("\n")}`;
  });
  const voiceContext = voice.length ? `\nSpeech linked to this drawing (automatic links are timing suggestions; selected/manual links are explicit user choices):\n${voice.join("\n")}` : "";
  const compactMap = (values: Record<string, string> | undefined, max: number) => values
    ? Object.fromEntries(Object.entries(values).slice(0, max).map(([k, v]) => [k, v.slice(0, 256)])) : undefined;
  const targets = a.targetSamples.map(s => ({
    selector: (s.details?.selector ?? s.elementPath)?.slice(0, 1024),
    label: s.label?.slice(0, 256),
    dataSource: s.dataSource?.slice(0, 1024),
    bounds: s.details?.bounds, text: s.details?.text?.slice(0, 600), tag: s.details?.tag,
    classes: s.details?.classes.slice(0, 20), attrs: compactMap(s.details?.attrs, 16), styles: compactMap(s.details?.styles, 24),
    component: s.details?.react?.chain.slice(0, 10), source: s.details?.react?.source,
  }));
  return redactImagePayloads(`Drawing attachment ${a.id}: ${a.image.width}×${a.image.height} composited viewport image, captured at ${a.createdAt} epoch ms. Page: ${a.pageUrl}\nCoordinates are captured CSS viewport pixels (${a.viewport.width}×${a.viewport.height}), scroll (${a.viewport.scrollX},${a.viewport.scrollY}). Marks may refer to multiple elements; do not assume a single cursor target.\n${strokes.join("\n")}${voiceContext}\nReferenced elements captured with the image: ${JSON.stringify(targets)}`) as string;
}

export const attachmentSummary = (annotations: readonly DrawingAnnotation[]) => annotations.map(a => `${a.id}: ${a.image.width}×${a.image.height}, ${a.strokes.length} marks, ${a.targetSamples.length} elements${a.voiceNotes?.length ? `, ${a.voiceNotes.length} voice notes / ${a.voiceNotes.reduce((count, note) => count + note.phrases.length, 0)} phrases` : ""}`).join("; ");

export function anthropicContent(user: string, annotations: readonly DrawingAnnotation[] = []): string | (ImageBlockParam | TextBlockParam)[] {
  if (!annotations.length) return user;
  return [...annotations.map(a => {
    const img = drawingImage(a);
    return { type: "image" as const, source: { type: "base64" as const, media_type: img.mediaType, data: img.data } };
  }), { type: "text", text: user }];
}
export function codexInput(user: string, annotations: readonly DrawingAnnotation[] = []) {
  return [{ type: "text", text: user, text_elements: [] }, ...annotations.map(a => ({ type: "image", url: a.image.dataUrl }))];
}
export function rpcImages(annotations: readonly DrawingAnnotation[] = []) {
  return annotations.map(a => { const img = drawingImage(a); return { type: "image", data: img.data, mimeType: img.mediaType }; });
}
export function opencodeParts(user: string, annotations: readonly DrawingAnnotation[] = []) {
  return [{ type: "text", text: user }, ...annotations.map(a => ({ type: "file", mime: drawingImage(a).mediaType, url: a.image.dataUrl, filename: `drawing-${a.id}.${drawingImage(a).mediaType === "image/png" ? "png" : "jpg"}` }))];
}
export function openaiContent(user: string, annotations: readonly DrawingAnnotation[] = []) {
  return annotations.length ? [{ type: "text", text: user }, ...annotations.map(a => ({ type: "image_url", image_url: { url: a.image.dataUrl } }))] : user;
}

/** A harness can otherwise silently replace unsupported images with a text placeholder. Fail before sending. */
export function assertDrawingVision(supported: boolean | undefined, provider: string, model: string): void {
  if (supported !== true) throw new Error(`${provider} model ${model || "(default)"} ${supported === false ? "does not support" : "has not advertised support for"} drawing images. Select a vision model (for example a current Claude or GPT model), or use Codex / Claude Code.`);
}

/** Debug responses may echo native request items. Strip image bytes before sending them to the inspector. */
export function redactImagePayloads(value: unknown): unknown {
  if (typeof value === "string") return value.replace(/data:image\/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/]+={0,2}/g, "[image attachment]");
  if (Array.isArray(value)) return value.map(redactImagePayloads);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.entries(record).map(([key, v]) => [key,
    key === "data" && (record.type === "base64" || record.type === "image") ? "[image bytes]" : redactImagePayloads(v),
  ]));
}
