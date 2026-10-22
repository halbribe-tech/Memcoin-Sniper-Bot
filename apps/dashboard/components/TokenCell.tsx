"use client";

import { useEffect, useState } from "react";
import { getSocket } from "@/lib/socket";
import { shortAddress } from "@/lib/format";

// metadata link → image URL, asked of the engine once per page load
const images = new Map<string, Promise<string | null>>();

function imageFor(metadataUri: string): Promise<string | null> {
  let p = images.get(metadataUri);
  if (!p) {
    p = new Promise((resolve) =>
      getSocket()
        .timeout(10_000)
        .emit("token:image", metadataUri, (err, url) => resolve(err ? null : url)),
    );
    images.set(metadataUri, p);
  }
  return p;
}

/** A coin as people know it: its image, ticker and name, with the mint small underneath. */
export function TokenCell({
  mint,
  name,
  symbol,
  metadataUri,
  showMint = true,
}: {
  mint: string;
  name?: string;
  symbol?: string;
  metadataUri?: string;
  showMint?: boolean;
}) {
  const [image, setImage] = useState<string | null>(null);
  const [broken, setBroken] = useState(false);

  useEffect(() => {
    let live = true;
    if (metadataUri) void imageFor(metadataUri).then((url) => live && setImage(url));
    return () => {
      live = false;
    };
  }, [metadataUri]);

  const label = symbol || name || shortAddress(mint);
  const initial = (symbol || name || "?").replace(/^\$/, "").charAt(0).toUpperCase() || "?";

  return (
    <div className="flex min-w-0 items-center gap-2">
      {image && !broken ? (
        // eslint-disable-next-line @next/next/no-img-element -- coin images come from arbitrary hosts
        <img
          src={image}
          alt=""
          width={28}
          height={28}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setBroken(true)}
          className="h-7 w-7 shrink-0 rounded-full border border-border bg-bg-elevated object-cover"
        />
      ) : (
        <span
          aria-hidden="true"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border bg-bg-elevated text-[11px] font-semibold text-fg-muted"
        >
          {initial}
        </span>
      )}
      <div className="flex min-w-0 flex-col leading-tight">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate font-semibold text-fg">{label}</span>
          {name && symbol && name !== symbol && <span className="truncate text-[11px] text-fg-muted">{name}</span>}
        </span>
        {showMint && <span className="font-mono text-[10px] text-fg-subtle">{shortAddress(mint)}</span>}
      </div>
    </div>
  );
}
