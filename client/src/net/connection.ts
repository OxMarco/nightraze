import { create, toBinary, fromBinary } from "@bufbuild/protobuf";
import {
  ClientMessageSchema,
  ServerMessageSchema,
} from "../gen/nightraze/v1/game_pb.js";
import { SnapshotBuffer } from "./interpolation.js";
import { applyTuning } from "../render/core.js";

export type ConnectionStatus =
  | { state: "idle" }
  | { state: "connecting" }
  | { state: "reconnecting"; attempt: number; retryInMs: number }
  | { state: "open"; playerId: number; worldSize: number }
  | { state: "dead"; playerId: number; worldSize: number; by: string; peakLight: number }
  | { state: "closed"; wasError: boolean; full: boolean };

export interface GameClientOptions {
  /** e.g. "ws://localhost:3000/play" */
  url: string;
  /** Max input messages per second sent to the server (server caps at 60). */
  inputRateHz?: number;
}

type Listener = () => void;

const DEFAULT_INPUT_RATE_HZ = 30;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 15_000;

/**
 * Owns the WebSocket, the protobuf codec, and the snapshot buffer.
 *
 * Deliberately framework-agnostic: React integrates via subscribe/getStatus
 * (useSyncExternalStore) for the low-frequency status, and reads world frames
 * imperatively from `buffer` inside requestAnimationFrame for the
 * high-frequency state. No React re-render happens per snapshot.
 */
export class GameClient {
  readonly buffer = new SnapshotBuffer();

  private readonly url: string;
  private readonly minInputIntervalMs: number;
  private ws: WebSocket | null = null;
  private status: ConnectionStatus = { state: "idle" };
  private listeners = new Set<Listener>();

  private lastName = "ember";
  private lastInputSentAt = 0;
  private pendingInput: { tx: number; ty: number } | null = null;
  private inputFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private reconnectEnabled = false;

  constructor(options: GameClientOptions) {
    this.url = options.url;
    this.minInputIntervalMs = 1000 / (options.inputRateHz ?? DEFAULT_INPUT_RATE_HZ);
  }

  // ---- status subscription (for useSyncExternalStore) ----

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getStatus = (): ConnectionStatus => this.status;

  private setStatus(status: ConnectionStatus): void {
    this.status = status;
    for (const l of this.listeners) l();
  }

  // ---- lifecycle ----

  connect(name: string): void {
    this.lastName = name;
    this.reconnectEnabled = true;
    this.reconnectAttempt = 0;
    this.cancelReconnect();
    this.openSocket();
  }

  private openSocket(): void {
    const previous = this.ws;
    this.ws = null;
    previous?.close(1000, "superseded");
    this.setStatus({ state: "connecting" });
    this.buffer.clear();

    const ws = new WebSocket(`${this.url}?name=${encodeURIComponent(this.lastName)}`);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    let sawError = false;

    ws.onmessage = (ev: MessageEvent) => {
      if (!(ev.data instanceof ArrayBuffer)) return;
      let msg;
      try {
        msg = fromBinary(ServerMessageSchema, new Uint8Array(ev.data));
      } catch {
        return; // malformed frame — ignore
      }
      switch (msg.msg.case) {
        case "welcome":
          this.reconnectAttempt = 0;
          this.setStatus({
            state: "open",
            playerId: msg.msg.value.playerId,
            worldSize: msg.msg.value.worldSize,
          });
          break;
        case "snapshot":
          this.buffer.push(msg.msg.value);
          break;
        case "tuning":
          // levers can move mid-session during a playtest sweep (§10)
          applyTuning({ glowG: msg.msg.value.glowG });
          break;
        case "dead":
          if (this.status.state === "open") {
            this.setStatus({
              ...this.status,
              state: "dead",
              by: msg.msg.value.by,
              peakLight: msg.msg.value.peakLight,
            });
          }
          break;
      }
    };

    ws.onclose = (ev: CloseEvent) => {
      if (this.ws !== ws) return; // superseded by a newer connection
      this.ws = null;
      this.clearInputQueue();

      // 1013 (Try Again Later) has its own visible capacity retry screen.
      if (ev.code === 1013) {
        this.setStatus({ state: "closed", wasError: false, full: true });
        return;
      }

      // Normal/user closes and policy violations must not loop. Service
      // restarts (1012), network loss (1006), and other abnormal closes do.
      const retryable = ev.code !== 1000 && ev.code !== 1008;
      if (this.reconnectEnabled && retryable) {
        this.scheduleReconnect();
        return;
      }

      this.setStatus({ state: "closed", wasError: sawError || ev.code === 1006, full: false });
    };

    ws.onerror = () => {
      if (this.ws !== ws) return;
      // Browsers follow this with close; let close be the single place that
      // decides whether retry is safe so we never create two retry timers.
      sawError = true;
    };
  }

  /** Retry with the last name used — for the "server full" bounce screen. */
  reconnect(): void {
    this.reconnectEnabled = true;
    this.cancelReconnect();
    this.openSocket();
  }

  disconnect(): void {
    this.reconnectEnabled = false;
    this.reconnectAttempt = 0;
    this.cancelReconnect();
    this.clearInputQueue();
    const ws = this.ws;
    this.ws = null;
    ws?.close(1000, "client disconnect");
    this.buffer.clear();
    this.setStatus({ state: "idle" });
  }

  private scheduleReconnect(): void {
    this.cancelReconnect();
    const attempt = ++this.reconnectAttempt;
    const base = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** (attempt - 1));
    const retryInMs = Math.min(
      RECONNECT_MAX_MS,
      Math.round(base * (0.8 + Math.random() * 0.4)),
    );
    this.setStatus({ state: "reconnecting", attempt, retryInMs });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.reconnectEnabled) this.openSocket();
    }, retryInMs);
  }

  private cancelReconnect(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private clearInputQueue(): void {
    if (this.inputFlushTimer) {
      clearTimeout(this.inputFlushTimer);
      this.inputFlushTimer = null;
    }
    this.pendingInput = null;
  }

  // ---- input ----

  /**
   * Set the desired movement direction. Magnitude up to 40 units acts as a
   * proportional throttle; callers can pass raw "mouse minus screen center"
   * vectors and the server caps larger values at full speed.
   * Throttled to inputRateHz; only the latest direction is kept.
   */
  sendDirection(tx: number, ty: number): void {
    this.pendingInput = { tx, ty };
    const now = performance.now();
    const elapsed = now - this.lastInputSentAt;
    if (elapsed >= this.minInputIntervalMs) {
      this.flushInput();
    } else if (!this.inputFlushTimer) {
      this.inputFlushTimer = setTimeout(
        () => this.flushInput(),
        this.minInputIntervalMs - elapsed,
      );
    }
  }

  // ---- actions (rare, sent immediately — no throttling needed) ----

  private sendAction(msg: Parameters<typeof create<typeof ClientMessageSchema>>[1]): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(toBinary(ClientMessageSchema, create(ClientMessageSchema, msg)));
  }

  /** Shutter / relight the lantern. */
  sendToggle(): void {
    this.sendAction({ msg: { case: "toggle", value: {} } });
  }

  /** Flare lunge toward a direction (screen-relative vector is fine). */
  sendDash(tx: number, ty: number): void {
    this.sendAction({ msg: { case: "dash", value: { tx, ty } } });
  }

  /** Vent ~27% of held light as a loose pile. */
  sendVent(): void {
    this.sendAction({ msg: { case: "vent", value: {} } });
  }

  /** One more run (only honored by the server while dead). */
  sendRespawn(): void {
    this.sendAction({ msg: { case: "respawn", value: {} } });
  }

  private flushInput(): void {
    if (this.inputFlushTimer) {
      clearTimeout(this.inputFlushTimer);
      this.inputFlushTimer = null;
    }
    const input = this.pendingInput;
    this.pendingInput = null;
    if (!input || this.ws?.readyState !== WebSocket.OPEN) return;

    this.lastInputSentAt = performance.now();
    this.ws.send(
      toBinary(
        ClientMessageSchema,
        create(ClientMessageSchema, {
          msg: { case: "input", value: input },
        }),
      ),
    );
  }
}
