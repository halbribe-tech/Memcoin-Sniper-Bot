"use client";

import { io, type Socket } from "socket.io-client";
import type {
  BankrollSnapshot,
  PoolDecision,
  PoolEvent,
  Position,
  PositionClosedEvent,
  PositionOpenedEvent,
  PositionUpdateEvent,
  StatsWindowKey,
  TradeStatsWindow,
} from "@sniperbot/shared";

export interface SystemStatus {
  mode: "paper" | "live";
  detectedTotal: number;
  skipped: number;
  queued: number;
  uptime: number;
  buys: number;
  skips: number;
  openPositions: number;
  realizedPnlUsd: number;
  botOn: boolean;
  feedLive: boolean;
  rpcRequests: number;
  logNotifications: number;
}

export interface ServerToClientEvents {
  "pool:new": (event: PoolEvent) => void;
  "decision:new": (decision: PoolDecision) => void;
  "system:status": (status: SystemStatus) => void;
  "position:opened": (e: PositionOpenedEvent) => void;
  "position:update": (e: PositionUpdateEvent) => void;
  "position:closed": (e: PositionClosedEvent) => void;
  "bankroll:snapshot": (snap: BankrollSnapshot) => void;
  "stats:reset": () => void;
}

export interface ClientToServerEvents {
  "pool:replay": (count: number, ack: (events: PoolEvent[]) => void) => void;
  "decision:replay": (count: number, ack: (decisions: PoolDecision[]) => void) => void;
  "positions:list": (
    ack: (data: { open: Position[]; recentlyClosed: Position[] }) => void,
  ) => void;
  "bankroll:get": (ack: (snap: BankrollSnapshot) => void) => void;
  "stats:get": (
    windowKey: StatsWindowKey,
    ack: (result: { ok: boolean; stats?: TradeStatsWindow; error?: string }) => void,
  ) => void;
  "bot:set": (on: boolean, ack: (result: { ok: boolean; botOn: boolean; error?: string }) => void) => void;
  "stats:reset": (ack: (result: { ok: boolean; error?: string }) => void) => void;
  "token:image": (metadataUri: string, ack: (imageUrl: string | null) => void) => void;
}

export type SniperSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let socket: SniperSocket | null = null;

export function getSocket(url?: string): SniperSocket {
  if (socket) return socket;
  const endpoint =
    url ?? process.env.NEXT_PUBLIC_ENGINE_URL ?? "http://localhost:4000";
  socket = io(endpoint, {
    autoConnect: true,
    transports: ["websocket", "polling"],
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5000,
  });
  return socket;
}

export function disconnectSocket(): void {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}
