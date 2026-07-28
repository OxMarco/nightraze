import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useGameContext } from "./GameContext.js";
import type { ConnectionStatus, GameClient } from "../net/connection.js";
import type { WorldFrame } from "../net/interpolation.js";
import type { LeaderboardEntry } from "./types.js";

/** The underlying client, for imperative access (e.g. inside a canvas loop). */
export function useGameClient(): GameClient {
  return useGameContext().client;
}

/**
 * Connection status as React state. Changes rarely (connect / welcome /
 * death / close), so subscribing normally via useSyncExternalStore is fine.
 */
export function useConnectionStatus(): ConnectionStatus {
  const client = useGameClient();
  return useSyncExternalStore(client.subscribe, client.getStatus, client.getStatus);
}

/** connect(name) / disconnect() bound to the shared client. */
export function useGameActions(): {
  connect: (name: string) => void;
  disconnect: () => void;
} {
  const client = useGameClient();
  return {
    connect: useCallback((name: string) => client.connect(name), [client]),
    disconnect: useCallback(() => client.disconnect(), [client]),
  };
}

/**
 * Drives a callback with interpolated world frames on requestAnimationFrame.
 *
 * This deliberately does NOT return the frame as React state: snapshots arrive
 * 25x/sec and frames are produced at display refresh rate, and pushing that
 * through setState would re-render the tree ~60x/sec. Instead the renderer
 * (your future canvas component) receives frames imperatively:
 *
 *   useWorldFrames((frame) => draw(canvasRef.current, frame));
 *
 * The callback is kept in a ref, so callers may pass an inline closure.
 */
export function useWorldFrames(onFrame: (frame: WorldFrame) => void): void {
  const client = useGameClient();
  const callbackRef = useRef(onFrame);
  callbackRef.current = onFrame;

  useEffect(() => {
    let rafId = 0;
    const loop = () => {
      const frame = client.buffer.sample();
      if (frame) callbackRef.current(frame);
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, [client]);
}

/**
 * World frame as React state, throttled to a low rate. For UI elements that
 * only need occasional world data (score display, minimap, spectator count) —
 * NOT for the main renderer, which should use useWorldFrames.
 */
export function useWorldStateThrottled(intervalMs = 250): WorldFrame | null {
  const client = useGameClient();
  const [frame, setFrame] = useState<WorldFrame | null>(null);

  useEffect(() => {
    const id = setInterval(() => setFrame(client.buffer.sample()), intervalMs);
    return () => clearInterval(id);
  }, [client, intervalMs]);

  return frame;
}

/** Leaderboard via the HTTP API, polled. */
export function useLeaderboard(pollIntervalMs = 2000): {
  entries: LeaderboardEntry[];
  error: string | null;
} {
  const { config } = useGameContext();
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const fetchOnce = async () => {
      try {
        const res = await fetch(`${config.apiUrl}/leaderboard`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as LeaderboardEntry[];
        if (!cancelled) {
          setEntries(data);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "fetch failed");
      }
    };

    void fetchOnce();
    const id = setInterval(fetchOnce, pollIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [config.apiUrl, pollIntervalMs]);

  return { entries, error };
}
