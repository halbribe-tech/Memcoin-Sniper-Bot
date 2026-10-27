import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCopyWallets } from "./copy-wallets.js";

const dir = mkdtempSync(join(tmpdir(), "copy-wallets-"));
const A = "cZDRUkxdmTUbUFoVDWeziUL6gfd9MNWGTd8THiN7Rnw";
const B = "Hgot6ZcPJFAfvVFi8EeqwmhUtrmH3MEoASz5bDLhWjza";

describe("copy wallets file", () => {
  test("reads addresses and names, skipping entries without an address", () => {
    const file = join(dir, "w.json");
    writeFileSync(file, JSON.stringify([{ address: A, name: "87" }, { address: B }, { name: "no address" }]));
    assert.deepEqual([...loadCopyWallets(file)], [[A, "87"], [B, ""]]);
  });

  test("a missing or broken file gives an empty list", () => {
    assert.equal(loadCopyWallets(join(dir, "missing.json")).size, 0);
    const broken = join(dir, "broken.json");
    writeFileSync(broken, "{not json");
    assert.equal(loadCopyWallets(broken).size, 0);
  });
});
