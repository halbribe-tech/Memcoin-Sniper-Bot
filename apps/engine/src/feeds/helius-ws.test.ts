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

  test("stopping closes the socket and stops its reconnecting", async () => {
    const stream = new HeliusLogStream();
    const s = stream as unknown as Internals;
    const calls: string[] = [];
    s.connection = {
      removeOnLogsListener: async () => undefined,
      _rpcWebSocket: {
        setAutoReconnect: (on: boolean) => calls.push(`autoReconnect=${on}`),
        setReconnectInterval: () => undefined,
        close: () => calls.push("close"),
      },
    };
    s.started = true;
    s.subscriptionIds = [1, 2];
    await stream.stop();
    assert.deepEqual(calls, ["autoReconnect=false", "close"]);
    assert.equal(s.connection, null);
    assert.equal(stream.isReady(), false);
  });
});
