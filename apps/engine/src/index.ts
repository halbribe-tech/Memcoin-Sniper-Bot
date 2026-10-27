import type { PoolEvent } from "@sniperbot/shared";
import { env, isPaperMode } from "./config/env.js";
import { logger } from "./utils/logger.js";
import { closeRedis, pingRedis } from "./state/redis.js";
import { disconnectPrisma, getPrisma } from "./state/db.js";
import { HeliusLogStream } from "./feeds/helius-ws.js";
import { PoolDetector } from "./feeds/pool-detector.js";
import { SocketServer } from "./api/socket-server.js";
import { PositionStore } from "./state/position-store.js";
import { PnlTracker } from "./analytics/pnl-tracker.js";
import { PaperBroker } from "./execution/broker.js";
import { BotSwitch } from "./execution/bot-switch.js";
import { MarketFeed } from "./execution/market-price.js";
import { restorePositions } from "./state/position-restore.js";
import { limitRpcRate, rpcUsage } from "./utils/rpc-meter.js";
import { wipeStoredStats } from "./state/reset-stats.js";
import { DecisionLog } from "./state/decision-stream.js";
import { SOL_MINT } from "./feeds/parsers/common.js";
import { launchTracker } from "./feeds/launch-tracker.js";
import { PositionPricer } from "./positions/pricer.js";
import { strategy, type BuyOrder, type StrategyContext } from "./strategy/index.js";
import { createAlerter } from "./alerts/index.js";

// pump.fun launches stay known this long, so a strategy can buy one on a later trade
const POOL_MEMORY_MS = 45 * 60_000;

async function main() {
  logger.info(
    {
      mode: env.MODE,
      logLevel: env.LOG_LEVEL,
      nodeEnv: env.NODE_ENV,
      enabledDexes: {
        pumpfun: env.ENABLE_PUMPFUN,
        pumpswap: env.ENABLE_PUMPSWAP,
        raydiumAmm: env.ENABLE_RAYDIUM_AMM,
        raydiumClmm: env.ENABLE_RAYDIUM_CLMM,
        raydiumLaunchpad: env.ENABLE_RAYDIUM_LAUNCHPAD,
        meteora: env.ENABLE_METEORA,
        orca: env.ENABLE_ORCA,
      },
    },
    "Sniper engine booting",
  );

  if (isPaperMode) {
    logger.info({ startingBalanceUsd: env.PAPER_STARTING_BALANCE_USD }, "PAPER MODE — no real funds at risk");
  } else {
    logger.warn({ liveMaxBankrollUsd: env.LIVE_MAX_BANKROLL_USD }, "LIVE MODE — real funds at risk");
  }

  // Before any connection exists: every RPC request from here on is paced.
  limitRpcRate(env.RPC_MAX_RPS);

  // === Infra checks ===
  const redisOk = await pingRedis();
  if (!redisOk) {
    logger.fatal("Redis ping failed. Is docker compose up?");
    process.exit(1);
  }
  logger.info("Redis: OK");

  try {
    await getPrisma().$queryRaw`SELECT 1`;
    logger.info("Postgres: OK");
  } catch (err) {
    logger.fatal({ err }, "Postgres connection failed");
    process.exit(1);
  }

  // === Pool detection ===
  const stream = new HeliusLogStream();
  const detector = new PoolDetector(stream);
  // every pump.fun launch's trades, curve and first buyers: free, from the same stream
  stream.on("pump-logs", (logs, slot) => launchTracker.ingest(logs, slot));

  // === Paper trading ===
  const positionStore = new PositionStore();
  const pnl = new PnlTracker(positionStore);
  // Market prices (Jupiter, free) for every open position, and SOL for curve prices.
  const market = new MarketFeed(() => {
    const mints = positionStore.list().map((p) => p.tokenMint);
    return [...mints, SOL_MINT];
  });
  const broker = new PaperBroker(positionStore, market);
  const decisions = new DecisionLog();
  const ctx: StrategyContext = {
    now: () => Date.now(),
    launch: (mint) => launchTracker.stats(mint),
    curve: (mint) => launchTracker.curveState(mint),
    solPriceUsd: () => market.get(SOL_MINT)?.priceUsd,
    bankroll: () => pnl.buildSnapshot(),
    openPositions: () => positionStore.list(),
  };
  const pricer = new PositionPricer(positionStore, market, broker, strategy, ctx);
  launchTracker.on("price", (mint, priceSol, virtualSol) => {
    if (!positionStore.list().some((p) => p.tokenMint === mint)) return;
    const solUsd = market.get(SOL_MINT)?.priceUsd;
    if (solUsd) pricer.onCurveTrade(mint, priceSol * solUsd, virtualSol * solUsd);
  });
  launchTracker.on("complete", (mint) => pricer.onCurveComplete(mint));
  const alerter = createAlerter({ store: positionStore, pnl });

  // What the last run left open carries on; what it closed stays in the totals.
  try {
    await restorePositions(positionStore, pnl);
  } catch (err) {
    logger.error({ err }, "could not restore positions from the last run — starting without them");
  }

  // === Strategy ===
  // Bumped by a stats reset: a pool detected before it is not acted on after it.
  let statsGeneration = 0;
  // recent pump.fun launches, so a buy decided on a later trade has its pool
  const recentPools = new Map<string, { pool: PoolEvent; generation: number }>();

  const act = (pool: PoolEvent, order: BuyOrder | null, generation: number, from: string) => {
    if (generation !== statsGeneration) return;
    const base = { poolAddress: pool.poolAddress, tokenMint: pool.tokenMint, signature: pool.signature, source: pool.source };
    if (!order) {
      // a pool skipped on detection is logged once; a trade that does not buy is not
      if (from === "pool") decisions.record({ ...base, decision: "skip", reason: "no buy", decidedAt: Date.now() });
      return;
    }
    if (broker.holds(pool.tokenMint)) return;
    decisions.record({ ...base, decision: "buy", reason: order.reason, decidedAt: Date.now() });
    logger.info({ mint: pool.tokenMint.slice(0, 8), sizeUsd: order.sizeUsd, reason: order.reason, from }, "strategy buys");
    void broker.buy(pool, order.sizeUsd);
  };

  detector.on("pool", (pool) => {
    const generation = statsGeneration;
    if (pool.source === "pumpfun") recentPools.set(pool.tokenMint, { pool, generation });
    Promise.resolve()
      .then(() => strategy.onPool(pool, ctx))
      .then(
        (order) => act(pool, order, generation, "pool"),
        (err) => logger.error({ err, mint: pool.tokenMint.slice(0, 8) }, "strategy.onPool threw — skipping"),
      );
  });

  launchTracker.on("trade", (trade) => {
    const known = recentPools.get(trade.mint);
    if (!known || !broker.isEnabled()) return;
    let order: BuyOrder | null = null;
    try {
      order = strategy.onTrade(trade, known.pool, ctx);
    } catch (err) {
      logger.error({ err, mint: trade.mint.slice(0, 8) }, "strategy.onTrade threw — skipping");
    }
    if (order) act(known.pool, order, known.generation, "trade");
  });

  setInterval(() => {
    const cutoff = Date.now() - POOL_MEMORY_MS;
    for (const [mint, k] of recentPools) if (k.pool.detectedAt < cutoff) recentPools.delete(mint);
  }, 60_000).unref();

  const urlNeedsKey = env.HELIUS_RPC_URL.endsWith("=");
  if (urlNeedsKey && !env.HELIUS_API_KEY) {
    logger.warn("RPC URL needs an api-key suffix but HELIUS_API_KEY is empty — pool detection will produce no events.");
  }

  alerter?.start();
  market.start();
  pricer.start();
  pnl.start(60_000);

  // Nothing subscribes to the RPC provider until the dashboard turns this on.
  const bot = new BotSwitch({
    feed: {
      start: () => stream.start(),
      stop: () => stream.stop(),
      isLive: () => stream.isReady(),
    },
    detector,
    broker,
  });

  // Back to a fresh bankroll: only with the bot off, so no buy lands mid-wipe.
  const resetStats = async () => {
    if (bot.isOn()) throw new Error("turn the bot off first");
    if (broker.isBuying()) throw new Error("a buy is still being priced — try again in a few seconds");
    await wipeStoredStats();
    statsGeneration++;
    recentPools.clear();
    positionStore.reset();
    pnl.reset();
    broker.resetStats();
    decisions.resetStats();
    detector.resetStats();
    logger.warn({ startingBalanceUsd: env.PAPER_STARTING_BALANCE_USD }, "stats reset from dashboard");
  };

  const socketServer = new SocketServer(detector, decisions, positionStore, pnl, bot, resetStats);
  await socketServer.start();

  logger.info({ botOn: bot.isOn(), socketPort: env.ENGINE_HTTP_PORT }, "engine live (paper trading, no strategy logic yet)");
  logger.warn(
    "Bot is OFF — not connected to the RPC provider (no credits spent), no pools, no trades. Press Bot OFF → ON on the dashboard.",
  );

  const statsTimer = setInterval(() => {
    const ds = detector.getStats();
    const dec = decisions.getStats();
    const ps = positionStore.getStats();
    const bs = broker.getStats();
    const snap = pnl.buildSnapshot();
    const as = alerter?.getStats();
    logger.info(
      {
        pools: ds.parsed,
        droppedMayhem: ds.skippedMayhem,
        droppedNotSolPaired: ds.skippedNotSolPaired,
        buys: dec.buys,
        skips: dec.skips,
        open: ps.open,
        closed: ps.totalClosed,
        winRate: `${ps.winRatePct.toFixed(1)}%`,
        balance: `$${snap.balanceUsd.toFixed(0)}`,
        realized: `$${ps.realizedPnlUsd.toFixed(2)}`,
        unrealized: `$${ps.unrealizedPnlUsd.toFixed(2)}`,
        failedFills: bs.failedFills,
        noPrice: bs.noPrice,
        bot: bot.isOn() ? "on" : "off",
        rpcRequests: rpcUsage().rpcRequests,
        alerts: as ? (as.disabled ? "disabled" : `${as.sent} sent, ${as.failed} failed, ${as.dropped} dropped`) : undefined,
      },
      "stats",
    );
  }, 30_000);

  await new Promise<void>((resolve) => {
    const shutdown = async (signal: string) => {
      logger.info({ signal }, "Shutdown");
      setTimeout(() => {
        logger.error("shutdown did not finish in 15s; forcing exit");
        exit(1);
      }, 15_000).unref();
      clearInterval(statsTimer);
      await alerter?.stop(signal);
      pricer.stop();
      market.stop();
      pnl.stop();
      await socketServer.stop();
      await stream.stop();
      await disconnectPrisma();
      await closeRedis();
      resolve();
    };
    process.once("SIGINT", () => void shutdown("SIGINT"));
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
  });

  logger.info("Goodbye.");
}

/** Exit once the logger has written everything — in dev it logs from a worker thread. */
function exit(code: number): void {
  setTimeout(() => process.exit(code), 1000).unref();
  logger.flush(() => process.exit(code));
}

main().then(
  // Exit explicitly: the Solana websocket client keeps reconnecting after its
  // listeners are removed and would hold a stopped engine open indefinitely.
  () => exit(0),
  (err) => {
    logger.fatal({ err }, "Engine crashed during boot");
    exit(1);
  },
);
