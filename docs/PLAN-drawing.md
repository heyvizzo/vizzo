# Drawing annotations

## Goal

Let a user mark the page, explain a change by typing or dictating, and send the image and element context together through Vizzo's existing feedback flow.

## First release

- Draw beside Comment in the browser toolbar; pen, arrow, rectangle and ellipse.
- Hover pickers before Pen open eight colors and stroke settings above their controls. Stroke settings offer normal/dashed/dotted lines and five widths (1.5/3/5/8/12 px, default level 2). Each stroke retains its color, width and style in previews, undo/redo, exports and model context. Active tools use the app's brand theme.
- Capture the current viewport every time Draw is entered, starting a fresh drawing. Exiting discards the draft. Draw on the frozen image so scrolling, resize and application updates cannot misplace marks. Keep captured element metadata alongside it.
- Undo/redo, delete the latest stroke, clear, and Escape to return to browsing. Preserve unfinished work when practical; never discard a submitted attachment during queue replay.
- Reuse the inline feedback form and its microphone/Shift dictation. Multiple strokes belong to one request. Existing Instant/queue behavior applies.
- Keep an image preview with the request in conversation and element threads. Open previews against the original image, not a potentially changed live page.
- Deliver the composited image plus descriptive stroke and element context to the router and solver, including background jobs and persistent thread requests. Unsupported transports must report the limitation explicitly instead of silently ignoring the drawing.

## Shared contract

`shared/annotations.ts` owns `DrawingAnnotation`, bounds validation and SVG rendering. Geometry uses captured viewport CSS coordinates; `image.dataUrl` contains the composited PNG/JPEG. Attach one optional `annotation` to `comment.send`, `turn.start`, stored request messages and model request options. Keep page-wide/multi-element sketches together rather than synthesizing a misleading single-element target.

## Parallel work

1. Drawing UI and Electron integration: `web/cursor/drawingOverlay.ts`, `electron/page-preload.ts`, `electron/main.ts`, `electron/preload.ts`, toolbar HTML.
2. Feedback flow and previews: `web/cursor/pageBridge.ts`, `web/chat/main.ts`, queue, thread overlay, reusable image preview.
3. Server and model delivery: protocol and thread attachment fields; session, orchestrators, persistence and adapters; supported native image payloads and explicit unsupported cases.
4. Coordinator: shared contract, integration review, documentation and cross-boundary checks.

All workers use GPT-6.1 Sol at medium reasoning. Existing workspace edits must be preserved.

## Validation

- Unit coverage for bounded payload validation, exported geometry, queue attachment retention and image request serialization.
- Typecheck, application build and relevant existing regression tests.
- Inspect the drawing UI and its submitted preview; verify typing, dictation wiring, undo/redo and mode transitions.
- Report any model or desktop interaction not exercised live.

## Progress

- Complete: shared contract and validation; drawing controls and capture; typed/dictated feedback and queue; message previews; server and native model image payloads; integration checks.
- Implementation used three parallel GPT-6.1 Sol workers at medium reasoning, with coordinator integration.

## Implementation details and limits

- The page's closed shadow root holds the editor. An early preload input listener keeps drawing gestures and typing out of the visited application's handlers. Native capture hides Vizzo's overlay; exported JPEGs contain the captured page and SVG marks only, at up to 1600 pixels on the longest side.
- Drawings are bounded to 200 strokes, 20,000 points, 12 referenced elements and 4,000,000 image data URL characters. Undo retains 100 history states. The original coordinate system survives window resizing.
- Native image payloads are wired for Codex, Claude Code, Pi, OMP, OpenCode, Anthropic Messages and OpenAI-compatible API adapters. Pi/OMP and OpenCode check advertised model image support. Grok CLI rejects drawing requests with a provider-switch message. API model support is determined by the selected endpoint's response.
- The Draw button stays visible but disabled when either the Fast or Smart tier uses Grok. Its tooltip explains the image limitation and names the tier to change in Settings → Models; model selection changes update it immediately.
- Central follow-ups retain the latest four distinct drawing images. Thread history retains eight; older messages keep textual geometry and an explicit expired-preview note. Existing process-lifetime conversation/thread retention applies. Run records preserve submitted annotations.
- Model request debug views show geometry and attachment summaries, with echoed image bytes redacted from raw responses.
- Native smoke exercises the real sandboxed page preload, screenshot capture, all four tools, keyboard undo/redo, deletion, atomic Clear undo, drawing re-entry, resizing, native typing, Shift dispatch, transcription gating, image export, and thread preview opening/rerendering/Escape/removal. It uses simulated transcription results and no live paid model request.
- Validation completed: 688 tests passed, 4 skipped; project and Electron typechecks passed; Vite and Electron builds passed; native drawing smoke passed.

## Speech links and moving marks

- Select supports single and Cmd/Ctrl multiple selection, bounded group dragging, arrow-key nudging, deleting selected marks, and undo/redo. Numbers, IDs, original creation intervals and voice links survive movement. Selection decoration stays out of the export.
- Dictation clips retain their IDs and epoch timing through the page bridge. Each clip stays bound to its original form, including when drawing gestures blur its text field; destroying the form drops late results.
- Word timings split long recordings into phrases and suggest associations with drawing activity. Several shorter recordings append separate notes in the same drawing session. Selecting marks before speaking creates explicit links. Without word timing, only stable selection or one unambiguous recording overlap is linked automatically.
- Voice links exposes phrases, mark numbers and association sources, with manual multi-mark assignment, Use selection and Clear. Clicking a phrase selects its text for editing. Deleting a mark hides its references; undo restores them. Export omits missing references.
- The shared contract and model context carry bounded voice notes and phrases, distinguishing automatic suggestions from explicit associations. Older drawings remain valid.
- This extension used the same three GPT-6.1 Sol medium workers for dictation routing, annotation contracts/geometry and phrase matching, with coordinator canvas integration. No new tests or native smoke runs were requested or performed for this extension; the test totals above describe the earlier implementation.
- Extension validation: project and explicit Electron typechecks passed; Vite and Electron builds passed. Live microphone and desktop interactions have not been exercised for this extension.
