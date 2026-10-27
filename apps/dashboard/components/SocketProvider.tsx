"use client";

import { useEffect } from "react";
import { getSocket } from "@/lib/socket";
import { useFeedStore } from "@/lib/store";

export function SocketProvider({ children }: { children: React.ReactNode }) {
  const addPool = useFeedStore((s) => s.addPool);
  const addDecision = useFeedStore((s) => s.addDecision);
  const setStatus = useFeedStore((s) => s.setStatus);
  const setConnected = useFeedStore((s) => s.setConnected);
  const replacePools = useFeedStore((s) => s.replacePools);
  const applyDecisions = useFeedStore((s) => s.applyDecisions);
  const hydratePositions = useFeedStore((s) => s.hydratePositions);
  const positionOpened = useFeedStore((s) => s.positionOpened);
  const positionUpdated = useFeedStore((s) => s.positionUpdated);
  const positionClosed = useFeedStore((s) => s.positionClosed);
  const setBankroll = useFeedStore((s) => s.setBankroll);

  useEffect(() => {
    const socket = getSocket();

    const onConnect = () => {
      setConnected(true);
      socket.emit("pool:replay", 50, (events) => {
        replacePools(events);
        socket.emit("decision:replay", 50, (decisions) => applyDecisions(decisions));
      });
      socket.emit("positions:list", ({ open, recentlyClosed }) => {
        hydratePositions(open, recentlyClosed);
      });
      socket.emit("bankroll:get", (snap) => setBankroll(snap));
    };

    const onDisconnect = () => setConnected(false);

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("pool:new", addPool);
    socket.on("decision:new", addDecision);
    socket.on("system:status", setStatus);
    socket.on("position:opened", ({ position }) => positionOpened(position));
    socket.on("position:update", ({ positionId, ...patch }) =>
      positionUpdated(positionId, patch),
    );
    socket.on("position:closed", ({ position }) => positionClosed(position));
    socket.on("bankroll:snapshot", setBankroll);
    // every page refetches on load, so a reload drops all cached results at once
    socket.on("stats:reset", () => window.location.reload());

    if (socket.connected) onConnect();

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("pool:new", addPool);
      socket.off("decision:new", addDecision);
      socket.off("system:status", setStatus);
      socket.off("position:opened");
      socket.off("position:update");
      socket.off("position:closed");
      socket.off("bankroll:snapshot");
      socket.off("stats:reset");
    };
  }, [
    addPool,
    addDecision,
    setStatus,
    setConnected,
    replacePools,
    applyDecisions,
    hydratePositions,
    positionOpened,
    positionUpdated,
    positionClosed,
    setBankroll,
  ]);

  return <>{children}</>;
}
