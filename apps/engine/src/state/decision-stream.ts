import { EventEmitter } from "node:events";
import type { PoolDecision } from "@sniperbot/shared";
import { getRedis } from "./redis.js";
import { getPrisma } from "./db.js";
import { childLogger } from "../utils/logger.js";

const log = childLogger("decision-stream");

export const DECISION_STREAM_KEY = "stream:decisions";
const STREAM_MAXLEN = 5000;

/** Keep a strategy decision for the dashboard's replay and in the database. */
export async function recordDecision(d: PoolDecision): Promise<void> {
  try {
    await getRedis().xadd(DECISION_STREAM_KEY, "MAXLEN", "~", STREAM_MAXLEN.toString(), "*", "decision", JSON.stringify(d));
  } catch (err) {
    log.error({ err, sig: d.signature }, "decision publish failed");
  }
  const row = { decision: d.decision, decisionReason: d.reason, decidedAt: new Date(d.decidedAt) };
  try {
    await getPrisma().poolDecision.upsert({
      where: { poolAddress: d.poolAddress },
      create: { poolAddress: d.poolAddress, ...row },
      update: row,
    });
  } catch (err) {
    log.warn({ err, poolAddress: d.poolAddress }, "decision persist failed");
  }
}

export async function getRecentDecisions(limit = 50): Promise<PoolDecision[]> {
  try {
    const entries = await getRedis().xrevrange(DECISION_STREAM_KEY, "+", "-", "COUNT", limit);
    return entries
      .map(([, fields]) => {
        const payload = fields[1];
        if (!payload) return null;
        try {
          return JSON.parse(payload) as PoolDecision;
        } catch {
          return null;
        }
      })
      .filter((d): d is PoolDecision => d !== null);
  } catch (err) {
    log.error({ err }, "failed to read recent decisions");
    return [];
  }
}

interface DecisionLogEvents {
  decision: (d: PoolDecision) => void;
}

export declare interface DecisionLog {
  on<E extends keyof DecisionLogEvents>(event: E, listener: DecisionLogEvents[E]): this;
  emit<E extends keyof DecisionLogEvents>(event: E, ...args: Parameters<DecisionLogEvents[E]>): boolean;
}

/** Every decision the strategy makes: counted, sent to the dashboard, stored. */
export class DecisionLog extends EventEmitter {
  private buys = 0;
  private skips = 0;

  record(d: PoolDecision): void {
    if (d.decision === "buy") this.buys++;
    else this.skips++;
    this.emit("decision", d);
    void recordDecision(d);
  }

  getStats() {
    return { buys: this.buys, skips: this.skips };
  }

  resetStats(): void {
    this.buys = 0;
    this.skips = 0;
  }
}
