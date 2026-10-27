"use client";

import { useFeedStore } from "@/lib/store";
import { formatPriceUsd, formatRelativeTime, formatUsd } from "@/lib/format";
import type { Position } from "@sniperbot/shared";
import { useMemo } from "react";
import { TokenCell } from "./TokenCell";

export function PositionsTable() {
  const openMap = useFeedStore((s) => s.openPositions);
  const positions = useMemo(
    () => Array.from(openMap.values()).sort((a, b) => b.openedAt - a.openedAt),
    [openMap],
  );

  if (positions.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-bg-card p-12 text-center text-sm text-fg-muted">
        No open positions. What the strategy buys will appear here.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-bg-card">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-bg-elevated text-[10px] uppercase tracking-wider text-fg-subtle">
          <tr>
            <th className="px-3 py-2 text-left">Token</th>
            <th className="px-3 py-2 text-left">Source</th>
            <th className="px-3 py-2 text-right">Size</th>
            <th className="px-3 py-2 text-right">Entry</th>
            <th className="px-3 py-2 text-right">Now</th>
            <th className="px-3 py-2 text-right">P&L</th>
            <th className="px-3 py-2 text-right">Peak</th>
            <th className="px-3 py-2 text-right">Sold</th>
            <th className="px-3 py-2 text-right">Age</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((p) => (
            <PositionRow key={p.id} position={p} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PositionRow({ position: p }: { position: Position }) {
  const pnlPositive = p.unrealizedPnlPct >= 0;
  const peakClass = p.peakGainPct >= 100
    ? "text-accent-green"
    : p.peakGainPct >= 0
      ? "text-fg"
      : "text-fg-muted";
  const soldPct = p.initialTokens > 0 ? (1 - p.remainingTokens / p.initialTokens) * 100 : 0;

  return (
    <tr className="border-t border-border hover:bg-bg-elevated/50">
      <td className="px-3 py-2">
        <TokenCell mint={p.tokenMint} name={p.tokenName} symbol={p.tokenSymbol} metadataUri={p.tokenMetadataUri} />
      </td>
      <td className="px-3 py-2 text-fg-muted">{p.source}</td>
      <td className="px-3 py-2 text-right tabular-nums">{formatUsd(p.entrySizeUsd)}</td>
      <td className="px-3 py-2 text-right tabular-nums text-fg-muted">
        {formatPriceUsd(p.entryPriceUsd)}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">
        {formatPriceUsd(p.currentPriceUsd)}
      </td>
      <td
        className={`px-3 py-2 text-right tabular-nums font-semibold ${
          pnlPositive ? "text-accent-green" : "text-accent-red"
        }`}
      >
        {pnlPositive ? "+" : ""}
        {p.unrealizedPnlPct.toFixed(1)}%
        <div className="text-[10px] font-normal text-fg-subtle">
          {pnlPositive ? "+" : ""}
          {formatUsd(p.unrealizedPnlUsd)}
        </div>
      </td>
      <td className={`px-3 py-2 text-right tabular-nums ${peakClass}`}>
        +{p.peakGainPct.toFixed(0)}%
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-fg-muted">
        {soldPct > 0 ? `${soldPct.toFixed(0)}%` : "—"}
        {p.realizedPnlUsd !== 0 && (
          <div className="text-[10px] text-fg-subtle">
            {p.realizedPnlUsd > 0 ? "+" : ""}
            {formatUsd(p.realizedPnlUsd)}
          </div>
        )}
      </td>
      <td className="px-3 py-2 text-right text-fg-muted">{formatRelativeTime(p.openedAt)}</td>
    </tr>
  );
}
