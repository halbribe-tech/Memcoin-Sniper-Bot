import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { creationBuyPriceSol, decodePumpCreateEvent, isSolPaired, launchSkipReason } from "./pumpfun-event.js";
import { curveStartPriceSol, poolEventFromCreate } from "./pumpfun.js";

// CreateEvent log lines from real mainnet create_v2 transactions
const SOL_PAIRED =
  "Program data: G3KpTd7rY3YRAAAAVEhJUyBJUyBHRU5OWSBXVEYCAAAAWU+UAAAAaHR0cHM6Ly9hdWdqZW1ybGpuaWthamJ6ZWJwdy5zdXBhYmFzZS5jby9zdG9yYWdlL3YxL29iamVjdC9wdWJsaWMvdG9rZW4tYXNzZXRzLzNlY2ViNGM2YjA1NDZlNTYwZjVjOGU3NWQzOTg5OTVhZDJkZDNmYWU3NTZhMTI2ZGRmMjliZTg1NzkzZDM1OWMuanNvbq1G6G/PaJDU/THAm/snTL22tJm2Xo/KO2wP774yy1P5G2zrkspofJCoDymGkShQ+Y5+uhZAaEscjob6gsngdT3xaiFBs6oV5QJUxM01uah6kU3a8BreNLCoAFjbvsJKX/FqIUGzqhXlAlTEzTW5qHqRTdrwGt40sKgAWNu+wkpfRAHZagAAAAAAENhH488DAACsI/wGAAAAAHjF+1HRAgAAgMakfo0DAAbd9uHudY/eGEJdvORszdq2GvxNg7kNJ/69+SjYoYv8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACsI/wGAAAAAAAAAAAAAAAAAA==";
const PUMP_PAIRED =
  "Program data: G3KpTd7rY3YHAAAATm93aGVyZQcAAABOT1dIRVJFWAAAAGh0dHBzOi8vc3Vtby1pcGZzLnF1aWNrbm9kZS1pcGZzLmNvbS9pcGZzL1FtUmVQZlYzTnI2OUZHa0ZqeWViQjNMUEsyRnJtVzNrem1mQ3Z5bVhjb3h4R0FE8fgg6GzJlXQjdsQA3aW/givcsk8gm0oVP5WCFOMt0qe2ccXaojGIyHrNOCFfd8y8yUUWTk7ArOE/whoPk/rg/uIu4ErmJ+99KJUXhqfOsTN8TkrAFIIwEQTTUzB0Apj+4i7gSuYn730olReGp86xM3xOSsAUgjARBNNTMHQCmDQB2WoAAAAAABDYR+PPAwD193jVmQAAAAB4xftR0QIAAIDGpH6NAwAG3fbh7nWP3hhCXbzkbM3athr8TYO5DSf+vfko2KGL/AAADEX3342ecpVihJM/bZi3VwMug9+EYE+14Rf/9h1bEvn193jVmQAAACwBAAAAAAAAAAA=";
const MAYHEM =
  "Program data: G3KpTd7rY3YGAAAAQ0hVTktZBQAAAENIVU5LQwAAAGh0dHBzOi8vaXBmcy5pby9pcGZzL1FtU3lNZVZmNEo2Y3czR3JUV1RqVUFUUU5mem5QUVNzM3ltemk0aDc4SkpBanoJSci8n3Ucju7aaeAU/eOKTCcLBd5Y+A+jWvgWMCCnDyDQ4RnuxhuumuAsZZ+D3VTgKVMmPKSWU9TgWudGZ1A0psx8ShhkP5PIqFm4DbwP53Km+GmSzKpM4JE4wFHJLT2mzHxKGGQ/k8ioWbgNvA/ncqb4aZLMqkzgkTjAUcktPUAB2WoAAAAAABDYR+PPAwAArCP8BgAAAAB4xftR0QIAAIDGpH6NAwAG3fbh7nWP3hhCXbzkbM3athr8TYO5DSf+vfko2KGL/AEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAArCP8BgAAAAAAAAAAAAAAAAA=";

// create_v2 plus the dev's 0.99 SOL buy in the same transaction
const WITH_DEV_BUY = [
  "Program data: G3KpTd7rY3YLAAAARUNIT1RSSUJCTEULAAAARUNIT1RSSUJCTEVAAAAAaHR0cHM6Ly9tZXRhLnV4ZW50by5pby9kYXRhLzk5ZDBkYzJlLTMzYWMtNDA3My04ZGI4LTliMmZhMTZhZDZjMKtnqF1nIHlDjzegmY8vSWYOkqXJTddaALUfCEQInnjvaFAdXaHjeLFx7iTOO/TekZgPQCuiJuwHGd6kJ9xschxfiKikr+BY96Qd2AgcDtGMnwLyvebsPRf3Az/1lpHqzl+IqKSv4Fj3pB3YCBwO0YyfAvK95uw9F/cDP/WWkerOLwLZagAAAAAAENhH488DAACsI/wGAAAAAHjF+1HRAgAAgMakfo0DAAbd9uHudY/eGEJdvORszdq2GvxNg7kNJ/69+SjYoYv8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACsI/wGAAAAAAAAAAAAAAAAAA==",
  "Program data: vdt/007mYe6rZ6hdZyB5Q483oJmPL0lmDpKlyU3XWgC1HwhECJ5477Bo3joAAAAA6oVanxofAAABX4iopK/gWPekHdgIHA7RjJ8C8r3m7D0X9wM/9ZaR6s4vAtlqAAAAALAUAjcHAAAAFop9qMiwAwCwaN46AAAAABbyalw3sgIASsL40N1cvJfjKJwZfLUGKlTz2Va5zm5RFfllZ6pcs+ZfAAAAAAAAAD0rjwAAAAAAX4iopK/gWPekHdgIHA7RjJ8C8r3m7D0X9wM/9ZaR6s4eAAAAAAAAABM2LQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAGJ1eV9leGFjdF9zb2xfaW4AAAAAAAAAAAAAAAAAAAAAAIgTAAAAAAAAnpVHAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACwaN46AAAAALAUAjcHAAAAsGjeOgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
];

const logs = (data: string) => [
  "Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P invoke [1]",
  "Program log: Instruction: CreateV2",
  data,
];
const drop = { skipMayhem: true, solPairsOnly: true };

describe("pump.fun CreateEvent", () => {
  test("a SOL-paired launch is kept, with its mint and curve read from the logs", () => {
    const e = decodePumpCreateEvent(logs(SOL_PAIRED));
    assert.ok(e);
    assert.equal(e.mint, "CfQF6gavwY9x2LurUkT6STmXog8DGdomRQN8ysFGZnGG");
    assert.equal(e.isMayhemMode, false);
    assert.ok(isSolPaired(e));
    assert.equal(launchSkipReason(e, drop), null);
    assert.ok(Math.abs(curveStartPriceSol(e) - 30 / 1_073_000_000) < 1e-15);
  });

  test("a coin paired with the PUMP token is dropped as not SOL-paired", () => {
    const e = decodePumpCreateEvent(logs(PUMP_PAIRED));
    assert.ok(e);
    assert.equal(e.quoteMint, "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn");
    assert.equal(launchSkipReason(e, drop), "not-sol-paired");
    assert.equal(launchSkipReason(e, { ...drop, solPairsOnly: false }), null);
  });

  test("a Mayhem Mode coin is dropped", () => {
    const e = decodePumpCreateEvent(logs(MAYHEM));
    assert.ok(e);
    assert.equal(e.mint, "dFvcUD59Pt6iG2zT1ZbuuXEFp8XdUuraDUdvwxFpump");
    assert.equal(e.isMayhemMode, true);
    assert.equal(launchSkipReason(e, drop), "mayhem");
    assert.equal(launchSkipReason(e, { ...drop, skipMayhem: false }), null);
  });

  test("logs without a CreateEvent decode to null", () => {
    assert.equal(decodePumpCreateEvent(["Program log: Instruction: Buy", "Program data: AAAA"]), null);
  });

  test("the pool event carries the mint, the fee payer and the curve's start price", () => {
    const e = decodePumpCreateEvent(logs(SOL_PAIRED));
    assert.ok(e);
    const pool = poolEventFromCreate(e, "sig", 1);
    assert.equal(pool.source, "pumpfun");
    assert.equal(pool.tokenMint, e.mint);
    assert.equal(pool.creatorWallet, e.user);
    assert.deepEqual(pool.token, { name: e.name, symbol: e.symbol, metadataUri: e.uri });
    assert.deepEqual(pool.rawEvent, { curveStartPriceSol: curveStartPriceSol(e), launchPriceSol: curveStartPriceSol(e) });
  });

  test("the dev's buy in the create transaction sets the launch price momentum is measured from", () => {
    const e = decodePumpCreateEvent(WITH_DEV_BUY);
    assert.ok(e);
    const start = curveStartPriceSol(e);
    const afterDevBuy = creationBuyPriceSol(WITH_DEV_BUY, e.mint);
    assert.ok(afterDevBuy);
    // 0.99 SOL into 30 virtual SOL: (30.99 / 30)^2 ≈ +6.7%
    assert.ok(Math.abs((afterDevBuy / start - 1) * 100 - 6.7) < 0.1);
    const pool = poolEventFromCreate(e, "sig", 1, afterDevBuy);
    assert.equal((pool.rawEvent as { launchPriceSol: number }).launchPriceSol, afterDevBuy);
  });

  test("a create without a buy has no launch buy, and another mint's trade is ignored", () => {
    assert.equal(creationBuyPriceSol(logs(SOL_PAIRED), "CfQF6gavwY9x2LurUkT6STmXog8DGdomRQN8ysFGZnGG"), null);
    assert.equal(creationBuyPriceSol(WITH_DEV_BUY, "CfQF6gavwY9x2LurUkT6STmXog8DGdomRQN8ysFGZnGG"), null);
  });
});
