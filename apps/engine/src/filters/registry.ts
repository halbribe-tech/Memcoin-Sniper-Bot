import type { Filter } from "./types.js";
import { liquidityMinFilter } from "./liquidity-min.js";
import { mintAuthorityFilter } from "./mint-authority.js";
import { freezeAuthorityFilter } from "./freeze-authority.js";
import { lpLockedFilter } from "./lp-locked.js";
import { topHoldersFilter } from "./top-holders.js";
import { honeypotSimFilter } from "./honeypot-sim.js";
import { devWalletFilter } from "./dev-wallet.js";
import { bundledLaunchFilter } from "./bundled-launch.js";
import { insiderDetectionFilter } from "./insider-detection.js";
import { antiSniperWarFilter } from "./anti-sniper-war.js";
import { curveMomentumFilter } from "./curve-momentum.js";
import { volumeVelocityFilter } from "./volume-velocity.js";
import { socialSignalFilter } from "./social-signal.js";
import { narrativeFilter } from "./narrative.js";

export const allFilters: Filter[] = [
  honeypotSimFilter,
  lpLockedFilter,
  mintAuthorityFilter,
  freezeAuthorityFilter,
  devWalletFilter,
  topHoldersFilter,
  liquidityMinFilter,
  bundledLaunchFilter,
  insiderDetectionFilter,
  antiSniperWarFilter,
  curveMomentumFilter,
  volumeVelocityFilter,
  socialSignalFilter,
  narrativeFilter,
];

export function enabledFilters(): Filter[] {
  return allFilters.filter((f) => f.enabled);
}
