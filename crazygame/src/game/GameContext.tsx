import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { GameClient } from "../net/connection.js";

export interface GameConfig {
  /** WebSocket endpoint, e.g. "ws://localhost:3000/play" */
  wsUrl: string;
  /** HTTP base for the REST API, e.g. "http://localhost:3000" */
  apiUrl: string;
  /** Max input messages per second (server caps at 60). Default 30. */
  inputRateHz?: number;
}

export interface GameContextValue {
  client: GameClient;
  config: GameConfig;
}

const GameContext = createContext<GameContextValue | null>(null);

export function GameProvider({
  config,
  children,
}: {
  config: GameConfig;
  children: ReactNode;
}) {
  const client = useMemo(
    () => new GameClient({ url: config.wsUrl, inputRateHz: config.inputRateHz }),
    // A new client only when the endpoint itself changes.
    [config.wsUrl, config.inputRateHz],
  );

  useEffect(() => {
    return () => client.disconnect();
  }, [client]);

  const value = useMemo<GameContextValue>(() => ({ client, config }), [client, config]);

  return <GameContext.Provider value={value}>{children}</GameContext.Provider>;
}

export function useGameContext(): GameContextValue {
  const ctx = useContext(GameContext);
  if (!ctx) throw new Error("useGameContext must be used inside <GameProvider>");
  return ctx;
}
