"use client";

import { Crosshair, Minus, Loader2 } from "lucide-react";
import type { PoolDecision } from "@sniperbot/shared";

export function DecisionBadge({ decision }: { decision?: PoolDecision["decision"] }) {
  if (!decision) {
    return (
      <span className="inline-flex items-center gap-1 rounded border border-border bg-bg-elevated px-2 py-0.5 text-[10px] font-semibold text-fg-dim">
        <Loader2 className="h-2.5 w-2.5 animate-spin" />
        NEW
      </span>
    );
  }

  if (decision === "buy") {
    return (
      <span className="inline-flex items-center gap-1 rounded border border-accent-green/40 bg-accent-green/10 px-2 py-0.5 text-[10px] font-bold tracking-wider text-accent-green">
        <Crosshair className="h-2.5 w-2.5" />
        BUY
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1 rounded border border-border bg-bg-elevated px-2 py-0.5 text-[10px] font-bold tracking-wider text-fg-muted">
      <Minus className="h-2.5 w-2.5" />
      SKIP
    </span>
  );
}
