import type { Strategy } from "./types.js";

export type { BuyOrder, SellOrder, Strategy, StrategyContext } from "./types.js";

/**
 * No logic yet: every pool is skipped and nothing is ever bought or sold.
 * Write the new strategy here; see ./types.ts for what each hook receives.
 */
export const strategy: Strategy = {
  onPool: () => null,
  onTrade: () => null,
  onPrice: () => null,
};
