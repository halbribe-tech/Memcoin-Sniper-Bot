import { getPrisma } from "./db.js";
import { getRedis } from "./redis.js";
import { POOL_STREAM_KEY } from "./pool-stream.js";
import { VERDICT_STREAM_KEY } from "./verdict-stream.js";

/**
 * Delete every stored pool, verdict, position, trade and bankroll snapshot,
 * and the Redis streams the live feed replays from. Filter presets and the
 * rugged-dev list stay: they are settings and knowledge, not results.
 */
export async function wipeStoredStats(): Promise<void> {
  const prisma = getPrisma();
  await prisma.$transaction([
    prisma.trade.deleteMany(),
    prisma.position.deleteMany(),
    prisma.filterResult.deleteMany(),
    prisma.poolDecision.deleteMany(),
    prisma.pool.deleteMany(),
    prisma.bankrollSnapshot.deleteMany(),
  ]);
  await getRedis().del(POOL_STREAM_KEY, VERDICT_STREAM_KEY);
}
