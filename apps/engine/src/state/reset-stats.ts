import { getPrisma } from "./db.js";
import { getRedis } from "./redis.js";
import { POOL_STREAM_KEY } from "./pool-stream.js";
import { DECISION_STREAM_KEY } from "./decision-stream.js";

/**
 * Delete every stored pool, decision, position, trade and bankroll snapshot,
 * and the Redis streams the live feed replays from.
 */
export async function wipeStoredStats(): Promise<void> {
  const prisma = getPrisma();
  await prisma.$transaction([
    prisma.trade.deleteMany(),
    prisma.position.deleteMany(),
    prisma.poolDecision.deleteMany(),
    prisma.pool.deleteMany(),
    prisma.bankrollSnapshot.deleteMany(),
  ]);
  await getRedis().del(POOL_STREAM_KEY, DECISION_STREAM_KEY);
}
