// Progress lines while a short task waits on the solver (chat mode, RunConfig.fillers). Once everything said so
// far has finished playing and a short pause has passed, the next line is spoken, until the answer is
// ready (stop() or cut()) or the lines run out. Lines come from deps.generateFillers, called in parallel with the
// solver. When the answer comes in mid-line, cut() breaks the line off so the answer isn't kept waiting.
import type { TurnBase } from "./turnBase.ts";
import { sleep } from "./turnBase.ts";

/** Silence after the previous speech before a filler starts. */
export const FILLER_GAP_MS = 900;
const POLL_MS = 100;

/** One spoken line: done once its audio has been sent (or it was cut); cut() breaks it off (TTS SegmentTts.cut). */
export interface FillerTake {
  done: Promise<void>;
  /** True when the user was hearing it. */
  cut(): boolean;
}

export class FillerScheduler {
  private stopped = false;
  /** Lines actually spoken (for meta). */
  readonly spoken: string[] = [];
  readonly done: Promise<void>;
  /** The last line started: kept after its audio was all sent, since it may still be playing (cut() checks). */
  private take: FillerTake | null = null;

  /**
   * @param speak  starts saying one line
   */
  constructor(
    private base: TurnBase,
    lines: Promise<string[]>,
    private speak: (line: string) => FillerTake,
    private gapMs = FILLER_GAP_MS,
  ) {
    this.done = lines.then((ls) => this.run(ls), () => {});
  }

  /** The answer is ready (or the turn ended): no new lines. A line already being spoken finishes. */
  stop(): void {
    this.stopped = true;
  }

  /**
   * The answer is ready: no new lines, and the one being spoken is broken off. True when the user heard it break
   * off (it was playing, and not about to end), so the answer should say why it cut in.
   */
  cut(): boolean {
    this.stopped = true;
    const take = this.take;
    this.take = null;
    return take ? take.cut() : false;
  }

  private get live(): boolean {
    return !this.stopped && !this.base.isFinished;
  }

  private async run(lines: string[]): Promise<void> {
    for (const line of lines) {
      // Wait until nothing is queued/playing, then the gap.
      while (this.live && !(this.base.output.idle && performance.now() >= this.base.output.playEnd + this.gapMs)) {
        await sleep(POLL_MS);
      }
      if (!this.live) return;
      this.spoken.push(line);
      const take = this.speak(line);
      this.take = take;
      try {
        await take.done;
      } catch (e) {
        console.warn("[fillers] speak failed", e);
        return;
      }
    }
  }
}
