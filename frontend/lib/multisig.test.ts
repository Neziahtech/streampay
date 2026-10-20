/**
 * Unit tests for frontend/lib/multisig.ts
 * Tests multisig detection logic for Stellar accounts and Soroban contracts.
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { detectMultisig } from "./multisig.ts";

describe("detectMultisig", () => {
  it("returns not multisig for empty or whitespace address", async () => {
    const res1 = await detectMultisig("");
    assert.equal(res1.isMultisig, false);

    const res2 = await detectMultisig("   ");
    assert.equal(res2.isMultisig, false);
  });

  it("returns not multisig for invalid address string", async () => {
    const res = await detectMultisig("not-an-address");
    assert.equal(res.isMultisig, false);
  });
});
