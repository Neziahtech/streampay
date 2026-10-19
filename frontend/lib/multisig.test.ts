import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fetchMultisigInfo, clearMultisigCache } from "./multisig.ts";

describe("Multisig Client Detection", () => {
  it("returns null for non-contract G... addresses", async () => {
    clearMultisigCache();
    const result = await fetchMultisigInfo("GBUQNYE74F2UKN3J5N2KTBCG5KST4TSSCS7TFVI4EB2XYG5W4W22E3SA");
    assert.equal(result, null);
  });

  it("returns null for invalid strings", async () => {
    clearMultisigCache();
    const result = await fetchMultisigInfo("invalid-address");
    assert.equal(result, null);
  });

  it("returns null for empty strings", async () => {
    clearMultisigCache();
    const result = await fetchMultisigInfo("");
    assert.equal(result, null);
  });
});
