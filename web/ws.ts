// Typed client for shared/protocol.ts, with clock sync (ARCHITECTURE §5).
import type { ClientMsg, ServerMsg } from "../shared/protocol.ts";
import { bestOffset, serverToClient, type ClockSync, type PingSample } from "../shared/clock.ts";

type Listener = (msg: ServerMsg) => void;
type AudioListener = (pcm: ArrayBuffer) => void;

const PINGS = 10;
const RESYNC_MS = 60_000;

export class LabSocket {
  private ws!: WebSocket;
  private listeners = new Set<Listener>();
  private audioListeners = new Set<AudioListener>();
  private pending = new Map<number, number>();
  private samples: PingSample[] = [];
  private nextPingId = 1;
  private resyncTimer?: ReturnType<typeof setInterval>;
  clock: ClockSync | null = null;
  onClock?: (c: ClockSync) => void;
  onStatus?: (s: "connecting" | "open" | "closed") => void;

  constructor(private url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`) {
    this.connect();
  }

  private connect(): void {
    this.onStatus?.("connecting");
    this.ws = new WebSocket(this.url);
    this.ws.binaryType = "arraybuffer";
    this.ws.onopen = () => {
      this.onStatus?.("open");
      this.send({ type: "hello", clientNow: performance.now() });
      void this.sync();
      clearInterval(this.resyncTimer);
      this.resyncTimer = setInterval(() => void this.sync(), RESYNC_MS);
    };
    this.ws.onclose = () => {
      this.onStatus?.("closed");
      clearInterval(this.resyncTimer);
      setTimeout(() => this.connect(), 1000);
    };
    this.ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) return this.audioListeners.forEach((l) => l(ev.data));
      const msg = JSON.parse(ev.data as string) as ServerMsg;
      if (msg.type === "pong") return this.onPong(msg);
      this.listeners.forEach((l) => l(msg));
    };
  }

  get isOpen(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  send(msg: ClientMsg): void {
    if (this.isOpen) this.ws.send(JSON.stringify(msg));
  }

  sendAudio(pcm: ArrayBuffer | ArrayBufferView<ArrayBuffer>): void {
    if (this.isOpen) this.ws.send(pcm);
  }

  on(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  onAudio(l: AudioListener): () => void {
    this.audioListeners.add(l);
    return () => this.audioListeners.delete(l);
  }

  /** Server mark time → client performance.now() time. */
  toClientTime(serverNow: number): number {
    return serverToClient(serverNow, this.clock?.offsetMs ?? 0);
  }

  /** Send PINGS pings, 50 ms apart; keep the lowest RTT. */
  async sync(): Promise<void> {
    this.samples = [];
    for (let i = 0; i < PINGS; i++) {
      const id = this.nextPingId++;
      const clientNow = performance.now();
      this.pending.set(id, clientNow);
      this.send({ type: "ping", id, clientNow });
      await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, 200));
    const best = bestOffset(this.samples);
    if (best) {
      this.clock = best;
      this.send({ type: "clock.sync", rttMs: best.rttMs, offsetMs: best.offsetMs });
      this.onClock?.(best);
    }
  }

  private onPong(msg: Extract<ServerMsg, { type: "pong" }>): void {
    const sent = this.pending.get(msg.id);
    if (sent === undefined) return;
    this.pending.delete(msg.id);
    this.samples.push({ clientSent: sent, clientRecv: performance.now(), serverNow: msg.serverNow });
  }
}
