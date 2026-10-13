// The subset of LabSocket the latency lab uses, so a dev-only FakeSocket (fake.ts, ?fake=1) can stand in for it.
import type { ClockSync } from "../../shared/clock.ts";
import type { ClientMsg, ServerMsg } from "../../shared/protocol.ts";

export interface LabSocketLike {
  readonly isOpen: boolean;
  readonly clock: ClockSync | null;
  send(msg: ClientMsg): void;
  sendAudio(pcm: ArrayBuffer | ArrayBufferView<ArrayBuffer>): void;
  on(l: (msg: ServerMsg) => void): () => void;
  onAudio(l: (pcm: ArrayBuffer) => void): () => void;
  toClientTime(serverNow: number): number;
}
