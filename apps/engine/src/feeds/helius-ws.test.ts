import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { HeliusLogStream } from "./helius-ws.js";

type Internals = {
  started: boolean;
  subscriptionIds: number[];
  startedAt: number;
  lastLogAt: number;
  connection: unknown;
};

describe("log stream liveness", () => {
  test("live only while logs arrive, not merely while subscribed", () => {
    const stream = new HeliusLogStream();
    const s = stream as unknown as Internals;
    s.started = true;
    s.subscriptionIds = [1];
    s.startedAt = Date.now() - 120_000;
    s.lastLogAt = 0;
    assert.equal(stream.isReady(), false, "subscribed two minutes ago, no log since");
    s.lastLogAt = Date.now();
    assert.equal(stream.isReady(), true);
  });

  test("stopping keeps its one connection for the next start, and leaves the socket to web3.js", async () => {
    const stream = new HeliusLogStream();
    const s = stream as unknown as Internals;
    const removed: number[] = [];
    const connection = { removeOnLogsListener: async (id: number) => void removed.push(id) };
    s.connection = connection;
    s.started = true;
    s.subscriptionIds = [1, 2];
    await stream.stop();
    assert.deepEqual(removed, [1, 2]);
    assert.equal(s.connection, connection);
    assert.equal(stream.isReady(), false);
  });

  test("an unsubscribe nobody answers does not hold stopping open", async () => {
    const stream = new HeliusLogStream();
    const s = stream as unknown as Internals;
    s.connection = { removeOnLogsListener: () => new Promise(() => undefined) };
    s.started = true;
    s.subscriptionIds = [1];
    const t0 = Date.now();
    await stream.stop();
    assert.ok(Date.now() - t0 < 5_000);
    assert.equal(stream.isReady(), false);
  });

  test("a silent socket is cut hard, without unsubscribing, so web3.js reconnects it", () => {
    const stream = new HeliusLogStream();
    const s = stream as unknown as Internals & { reconnectIfSilent(): void };
    let terminated = 0;
    let removed = 0;
    s.connection = {
      removeOnLogsListener: async () => void removed++,
      _rpcWebSocket: { setReconnectInterval: () => undefined, socket: { terminate: () => void terminated++ } },
    };
    s.started = true;
    s.subscriptionIds = [1];
    s.startedAt = Date.now() - 120_000;
    s.lastLogAt = 0;
    s.reconnectIfSilent();
    assert.equal(terminated, 1);
    assert.equal(removed, 0, "no unsubscribe, which once looped until the heap ran out");
    assert.equal(stream.isReady(), true, "a fresh minute to judge the new socket");
    s.reconnectIfSilent();
    assert.equal(terminated, 1, "not cut again inside that minute");
  });
});
