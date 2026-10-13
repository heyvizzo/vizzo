// Progress lines while a short task waits on Opus (chat mode, RunConfig.fillers). Once everything said so
// far has finished playing and a short pause has passed, the next line is spoken, until the answer is
// ready (stop()) or the lines run out. Lines come from deps.generateFillers, called in parallel with Opus.
import type { TurnBase } from "./turnBase.ts";
import { sleep } from "./turnBase.ts";

/** Silence after the previous speech before a filler starts. */
export const FILLER_GAP_MS = 900;
const POLL_MS = 100;

export class FillerScheduler {
  private stopped = false;
  /** Lines actually spoken (for meta). */
  readonly spoken: string[] = [];
  readonly done: Promise<void>;

  /**
   * @param speak  says one line and resolves once its audio has been sent (B: TTS socket closed;
   *               A/C: the filler response finished)
   */
  constructor(
    private base: TurnBase,
    lines: Promise<string[]>,
    private speak: (line: string) => Promise<void>,
    private gapMs = FILLER_GAP_MS,
  ) {
    this.done = lines.then((ls) => this.run(ls), () => {});
  }

  /** The answer is ready (or the turn ended): no new lines. A line already being spoken finishes. */
  stop(): void {
    this.stopped = true;
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
      try {
        await this.speak(line);
      } catch (e) {
        console.warn("[fillers] speak failed", e);
        return;
      }
    }
  }
}
