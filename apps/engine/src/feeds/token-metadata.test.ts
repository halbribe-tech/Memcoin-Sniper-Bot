import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { resolveTokenImage } from "./token-metadata.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function serve(body: unknown): string[] {
  const asked: string[] = [];
  globalThis.fetch = (async (url: string) => {
    asked.push(String(url));
    return new Response(JSON.stringify(body));
  }) as typeof fetch;
  return asked;
}

describe("token images", () => {
  test("reads the image from the metadata, and sends ipfs links through a working gateway", async () => {
    const asked = serve({ name: "Cat", image: "https://ipfs.io/ipfs/QmImage" });
    assert.equal(await resolveTokenImage("ipfs://QmMeta1"), "https://pump.mypinata.cloud/ipfs/QmImage");
    assert.deepEqual(asked, ["https://pump.mypinata.cloud/ipfs/QmMeta1"]);
  });

  test("a retired ipfs.io link is fetched from pump.fun's gateway, then the next one if that fails", async () => {
    const asked: string[] = [];
    globalThis.fetch = (async (url: string) => {
      asked.push(String(url));
      return asked.length === 1 ? new Response("busy", { status: 429 }) : new Response(JSON.stringify({ image: "https://cdn.example.com/b.png" }));
    }) as typeof fetch;
    assert.equal(await resolveTokenImage("https://ipfs.io/ipfs/QmMeta2"), "https://cdn.example.com/b.png");
    assert.deepEqual(asked, ["https://pump.mypinata.cloud/ipfs/QmMeta2", "https://ipfs.filebase.io/ipfs/QmMeta2"]);
  });

  test("asks once per link", async () => {
    const asked = serve({ image: "https://cdn.example.com/a.png" });
    await resolveTokenImage("https://meta.example.com/once.json");
    await resolveTokenImage("https://meta.example.com/once.json");
    assert.equal(asked.length, 1);
  });

  test("never fetches plain http, localhost or bare IPs, which a launcher could aim at this machine", async () => {
    const asked = serve({ image: "https://cdn.example.com/a.png" });
    for (const uri of ["http://meta.example.com/x.json", "https://localhost/x.json", "https://127.0.0.1/x.json", "https://192.168.1.10/x.json"]) {
      assert.equal(await resolveTokenImage(uri), null, uri);
    }
    assert.deepEqual(asked, []);
  });

  test("an image link on a private host is dropped", async () => {
    serve({ image: "https://10.0.0.5/a.png" });
    assert.equal(await resolveTokenImage("https://meta.example.com/private-image.json"), null);
  });
});
