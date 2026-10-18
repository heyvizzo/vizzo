// Helpers shared by the orchestrators: a lazily-opened per-turn Scribe stream.
import type { SttStream } from "../adapters/types.ts";
import type { OrchestratorDeps } from "./types.ts";
import type { TurnBase } from "./turnBase.ts";

// ── Scribe (one session per turn) ──────────────────────────────────────────

/**
 * Per-turn Scribe stream. `open()` is idempotent; audio pushed before the socket is open is buffered.
 * Partials go to the client as `stt.partial`.
 */
export class LazyScribe {
  private p: Promise<SttStream> | null = null;
  private stream: SttStream | null = null;
  private buf: Buffer[] = [];
  private committed = false;

  constructor(private base: TurnBase, private deps: Pick<OrchestratorDeps, "openScribe">) {}

  open(): Promise<SttStream> {
    if (!this.p) {
      const lang = this.base.ctx.config.language;
      this.p = this.base.track(this.deps.openScribe({ mark: this.base.mark, model: this.base.ctx.config.sttModel, ...(lang && lang !== "auto" ? { language: lang } : {}) })).then((s) => {
        this.stream = s;
        s.onPartial((t) => this.base.sttPartial(t));
        for (const b of this.buf.splice(0)) s.pushAudio(b);
        if (this.committed) s.commit();
        return s;
      });
      this.p.catch(() => {}); // callers observe the rejection where it matters
    }
    return this.p;
  }

  push(pcm: Buffer): void {
    if (this.committed) return;
    if (this.stream) this.stream.pushAudio(pcm);
    else this.buf.push(pcm);
  }

  /** Commit (now, or as soon as the socket opens) and wait for the final transcript. */
  async final(): Promise<{ text: string; words: import("../../shared/protocol.ts").Word[]; language?: string }> {
    const s = await this.open();
    if (!this.committed) { this.committed = true; s.commit(); }
    return s.final();
  }

  /** Mark committed right away so later audio is dropped even if the socket isn't open yet. */
  commit(): void {
    if (this.committed) return;
    this.committed = true;
    this.stream?.commit();
  }

  get seconds(): number { return this.stream?.seconds ?? 0; }
}
