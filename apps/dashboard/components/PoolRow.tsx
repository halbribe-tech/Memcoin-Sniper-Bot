"use client";

import { memo } from "react";
import type { PoolDecision, PoolEvent } from "@sniperbot/shared";
import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import { formatPriceUsd, formatRelativeTime, formatUsd, shortAddress } from "@/lib/format";
import { DecisionBadge } from "./DecisionBadge";
import { TokenCell } from "./TokenCell";
import { useFeedStore } from "@/lib/store";

const SOURCE_STYLES: Record<string, { label: string; cls: string }> = {
  pumpfun: { label: "pump.fun", cls: "border-source-pumpfun/30 bg-source-pumpfun/10 text-source-pumpfun" },
  pumpswap: { label: "PumpSwap", cls: "border-source-pumpswap/30 bg-source-pumpswap/10 text-source-pumpswap" },
  "raydium-amm": { label: "Raydium AMM", cls: "border-source-raydium/30 bg-source-raydium/10 text-source-raydium" },
  "raydium-clmm": { label: "Raydium CLMM", cls: "border-source-raydium/30 bg-source-raydium/10 text-source-raydium" },
  "raydium-launchpad": { label: "LetsBonk", cls: "border-source-raydium/30 bg-source-raydium/10 text-source-raydium" },
  meteora: { label: "Meteora", cls: "border-source-meteora/30 bg-source-meteora/10 text-source-meteora" },
  orca: { label: "Orca", cls: "border-source-orca/30 bg-source-orca/10 text-source-orca" },
};

interface PoolRowProps {
  pool: PoolEvent;
  decision?: PoolDecision;
  isNew?: boolean;
}

function PoolRowImpl({ pool, decision, isNew }: PoolRowProps) {
  const expandedSig = useFeedStore((s) => s.expandedSig);
  const toggleExpanded = useFeedStore((s) => s.toggleExpanded);
  const expanded = expandedSig === pool.signature;

  const src = SOURCE_STYLES[pool.source] ?? {
    label: pool.source,
    cls: "border-border bg-bg-elevated text-fg-muted",
  };
  const dexscreenerUrl = `https://dexscreener.com/solana/${pool.tokenMint}`;
  const solscanUrl = `https://solscan.io/tx/${pool.signature}`;

  const decisionRing =
    decision?.decision === "buy" ? "border-l-2 border-l-accent-green" : "border-l-2 border-l-border";

  return (
    <div
      className={`group rounded-lg border border-border bg-bg-card transition-colors hover:border-border-strong hover:bg-bg-card/60 ${decisionRing} ${
        isNew ? "animate-slide-in" : ""
      }`}
    >
      <button
        type="button"
        onClick={() => toggleExpanded(pool.signature)}
        className="w-full cursor-pointer text-left hover:bg-bg-elevated/30 active:bg-bg-elevated/60"
        aria-expanded={expanded}
        aria-label={`Toggle details for pool ${pool.tokenMint}`}
      >
        <div className="grid grid-cols-12 gap-2 sm:gap-3 p-3">
          {/* Source + age */}
          <div className="col-span-12 sm:col-span-3 lg:col-span-2 flex items-center justify-between sm:flex-col sm:items-start sm:gap-1">
            <span
              className={`inline-flex items-center rounded border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${src.cls}`}
            >
              {src.label}
            </span>
            <span className="text-[11px] text-fg-subtle tabular-nums">
              {formatRelativeTime(pool.detectedAt)}
            </span>
          </div>

          {/* Mint + decision */}
          <div className="col-span-12 sm:col-span-5 lg:col-span-5 min-w-0 flex flex-col gap-1.5">
            <div className="flex items-center gap-2 min-w-0">
              <DecisionBadge decision={decision?.decision} />
              <TokenCell
                mint={pool.tokenMint}
                name={pool.token?.name}
                symbol={pool.token?.symbol}
                metadataUri={pool.token?.metadataUri}
              />
            </div>
            <div className="flex items-center gap-2 min-w-0 text-fg-muted">
              <span className="text-[10px] uppercase tracking-wider text-fg-subtle">DEV</span>
              <code className="truncate font-mono text-[11px]">
                {shortAddress(pool.creatorWallet, 6)}
              </code>
            </div>
          </div>

          {/* Liquidity */}
          <div className="col-span-6 sm:col-span-2 lg:col-span-2 flex flex-col">
            <span className="text-[10px] uppercase tracking-wider text-fg-subtle">Liquidity</span>
            <span className="font-mono text-sm tabular-nums text-fg">
              {formatUsd(pool.initialLiquidityUsd, { compact: true })}
            </span>
          </div>

          {/* Price */}
          <div className="col-span-6 sm:col-span-2 lg:col-span-2 flex flex-col">
            <span className="text-[10px] uppercase tracking-wider text-fg-subtle">Price</span>
            <span className="font-mono text-sm tabular-nums text-fg">
              {formatPriceUsd(pool.initialPriceUsd)}
            </span>
          </div>

          {/* Toggle chevron */}
          <div className="col-span-12 lg:col-span-1 flex items-center justify-end gap-2 mt-1 lg:mt-0">
            <ChevronIcon expanded={expanded} />
          </div>

        </div>
      </button>

      {expanded && (
        <ExpandedDetail
          decision={decision}
          dexscreenerUrl={dexscreenerUrl}
          solscanUrl={solscanUrl}
        />
      )}
    </div>
  );
}

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return expanded ? (
    <ChevronDown className="h-4 w-4 text-fg-subtle group-hover:text-fg" />
  ) : (
    <ChevronRight className="h-4 w-4 text-fg-subtle group-hover:text-fg" />
  );
}

function ExpandedDetail({
  decision,
  dexscreenerUrl,
  solscanUrl,
}: {
  decision?: PoolDecision;
  dexscreenerUrl: string;
  solscanUrl: string;
}) {
  return (
    <div className="border-t border-border bg-bg-elevated p-3 sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <p className="text-fg-muted">
          <span className="text-fg-subtle">Strategy:</span> {decision ? decision.reason : "not decided yet"}
        </p>
        <div className="flex gap-2">
          <a
            href={dexscreenerUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="flex h-7 items-center gap-1 rounded border border-border bg-bg-card px-2 text-[10px] font-medium text-fg-muted hover:text-fg"
          >
            DexScreener
            <ExternalLink className="h-2.5 w-2.5" />
          </a>
          <a
            href={solscanUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="flex h-7 items-center gap-1 rounded border border-border bg-bg-card px-2 text-[10px] font-medium text-fg-muted hover:text-fg"
          >
            Solscan
            <ExternalLink className="h-2.5 w-2.5" />
          </a>
        </div>
      </div>
    </div>
  );
}

export const PoolRow = memo(PoolRowImpl);
