import { createServer, type Server as HttpServer } from "node:http";
import { Server as IOServer } from "socket.io";
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
import { env } from "../config/env.js";
import { childLogger } from "../utils/logger.js";
import { getRecentPools } from "../state/pool-stream.js";
import { getRecentDecisions, type DecisionLog } from "../state/decision-stream.js";
import type { PoolDetector } from "../feeds/pool-detector.js";
import type { PositionStore } from "../state/position-store.js";
import type { PnlTracker } from "../analytics/pnl-tracker.js";
import type { BotSwitch } from "../execution/bot-switch.js";
import { rpcUsage } from "../utils/rpc-meter.js";
import { computeStatsWindow } from "../analytics/stats-window.js";
import { resolveTokenImage } from "../feeds/token-metadata.js";

const log = childLogger("socket-server");

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
  // false at every boot: no RPC subscription, no pools, no new positions
  botOn: boolean;
  // on, and something is actually delivering pools
  feedLive: boolean;
  // since the engine started — rpcRequests is roughly the credits spent
  rpcRequests: number;
  logNotifications: number;
}

export class SocketServer {
  private http: HttpServer;
  private io: IOServer<ClientToServerEvents, ServerToClientEvents>;
  private readonly detector: PoolDetector;
  private readonly decisions: DecisionLog;
  private readonly positionStore: PositionStore;
  private readonly pnl: PnlTracker;
  private readonly bot: BotSwitch;
  private readonly resetStats: () => Promise<void>;
  private readonly startedAt = Date.now();
  private statusInterval: NodeJS.Timeout | null = null;

  constructor(
    detector: PoolDetector,
    decisions: DecisionLog,
    positionStore: PositionStore,
    pnl: PnlTracker,
    bot: BotSwitch,
    resetStats: () => Promise<void>,
  ) {
    this.detector = detector;
    this.decisions = decisions;
    this.positionStore = positionStore;
    this.pnl = pnl;
    this.resetStats = resetStats;
    this.bot = bot;

    this.http = createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, uptime: Date.now() - this.startedAt }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    this.io = new IOServer(this.http, {
      cors: { origin: "*", methods: ["GET", "POST"] },
      transports: ["websocket", "polling"],
    });

    this.io.on("connection", (socket) => {
      log.info({ id: socket.id, clients: this.io.sockets.sockets.size }, "client connected");

      socket.emit("system:status", this.buildStatus());

      socket.on("pool:replay", async (count, ack) => {
        const safe = Math.min(Math.max(1, count), 200);
        const recent = await getRecentPools(safe);
        ack(recent);
      });

      socket.on("decision:replay", async (count, ack) => {
        const safe = Math.min(Math.max(1, count), 200);
        ack(await getRecentDecisions(safe));
      });

      socket.on("positions:list", (ack) => {
        ack({
          open: this.positionStore.list(),
          recentlyClosed: this.positionStore.recentlyClosed(50),
        });
      });

      socket.on("bankroll:get", (ack) => {
        ack(this.pnl.buildSnapshot());
      });

      socket.on("stats:get", async (windowKey, ack) => {
        try {
          const stats = await computeStatsWindow(windowKey);
          ack({ ok: true, stats });
        } catch (err) {
          log.warn({ err, windowKey }, "stats:get failed");
          ack({ ok: false, error: (err as Error).message });
        }
      });

      socket.on("bot:set", async (on, ack) => {
        const reply = typeof ack === "function" ? ack : () => undefined;
        if (typeof on !== "boolean") {
          reply({ ok: false, botOn: this.bot.isOn(), error: "expected true or false" });
          return;
        }
        try {
          await this.bot.set(on);
          reply({ ok: true, botOn: this.bot.isOn() });
        } catch (err) {
          log.error({ err }, "bot switch failed");
          reply({ ok: false, botOn: this.bot.isOn(), error: (err as Error).message });
        }
        // every open dashboard flips at once, not on the next 2s tick
        this.io.emit("system:status", this.buildStatus());
      });

      socket.on("stats:reset", async (ack) => {
        const reply = typeof ack === "function" ? ack : () => undefined;
        try {
          await this.resetStats();
          reply({ ok: true });
        } catch (err) {
          log.error({ err }, "stats reset failed");
          reply({ ok: false, error: (err as Error).message });
          return;
        }
        // every open dashboard drops what it has cached
        this.io.emit("stats:reset");
        this.io.emit("system:status", this.buildStatus());
        this.io.emit("bankroll:snapshot", this.pnl.buildSnapshot());
      });

      socket.on("token:image", async (metadataUri, ack) => {
        const reply = typeof ack === "function" ? ack : () => undefined;
        if (typeof metadataUri !== "string" || metadataUri.length > 500) return reply(null);
        reply(await resolveTokenImage(metadataUri));
      });

      socket.on("disconnect", (reason) => {
        log.info({ id: socket.id, reason }, "client disconnected");
      });
    });

    this.detector.on("pool", (event) => this.io.emit("pool:new", event));
    this.decisions.on("decision", (decision) => this.io.emit("decision:new", decision));
    this.positionStore.on("position-opened", (e) => {
      this.io.emit("position:opened", e);
      // the buy moves "invested" and exposure now, not at the next close
      this.io.emit("bankroll:snapshot", this.pnl.buildSnapshot());
    });
    this.positionStore.on("position-update", (e) => this.io.emit("position:update", e));
    this.positionStore.on("position-closed", (e) => {
      this.io.emit("position:closed", e);
      this.io.emit("bankroll:snapshot", this.pnl.buildSnapshot());
    });
  }

  private buildStatus(): SystemStatus {
    const detectorStats = this.detector.getStats();
    const decisionStats = this.decisions.getStats();
    const posStats = this.positionStore.getStats();
    return {
      mode: env.MODE,
      detectedTotal: detectorStats.parsed,
      skipped: detectorStats.skipped,
      queued: detectorStats.queued,
      uptime: Date.now() - this.startedAt,
      buys: decisionStats.buys,
      skips: decisionStats.skips,
      openPositions: posStats.open,
      realizedPnlUsd: posStats.realizedPnlUsd,
      botOn: this.bot.isOn(),
      feedLive: this.bot.feedLive(),
      ...rpcUsage(),
    };
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.http.once("error", reject);
      this.http.listen(env.ENGINE_HTTP_PORT, () => {
        log.info({ port: env.ENGINE_HTTP_PORT }, "Socket.io server listening");
        // The bankroll rides along: take-profits and unrealized P&L change it
        // between opens and closes, and the dashboard only asked for it once,
        // on connect — so "invested" and "realized" went stale until a close.
        this.statusInterval = setInterval(() => {
          this.io.emit("system:status", this.buildStatus());
          this.io.emit("bankroll:snapshot", this.pnl.buildSnapshot());
        }, 2000);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.statusInterval) {
      clearInterval(this.statusInterval);
      this.statusInterval = null;
    }
    // io.close() also closes the http server it is attached to. Closing it a
    // second time rejects with ERR_SERVER_NOT_RUNNING, which crashed shutdown
    // before Postgres and Redis were disconnected.
    await this.io.close();
    if (this.http.listening) {
      await new Promise<void>((resolve, reject) =>
        this.http.close((err) => (err ? reject(err) : resolve())),
      );
    }
    log.info("stopped");
  }
}
