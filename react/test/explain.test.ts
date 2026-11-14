import { describe, expect, it } from "vitest";
import { explain, validateRecipient } from "../src/useTransfer.js";

/**
 * Every failure a user can hit must become a sentence that tells them what
 * happened and what to do. A raw protocol error reaching the screen is a bug.
 */
describe("error copy", () => {
  const cases: Array<[string, string, RegExp]> = [
    ["wallet rejection (MetaMask)", "MetaMask Tx Signature: User denied message signature.", /declined.*Nothing was sent/i],
    ["wallet rejection (code)", "Error: user rejected action (code 4001)", /declined/i],
    ["wallet rejection (TronLink)", "Confirmation declined by user", /declined.*Nothing was sent/i],
    ["relayer out of energy", "energy unavailable: cannot acquire 88000 energy under 80 sun/energy", /capacity.*different relayer|run one/i],
    ["not enough USDT", "insufficient balance: account has 1000000, needs 3500000", /does not hold enough USDT/i],
    ["expired quote", "permit expired", /expired.*fresh quote/i],
    ["raced nonce", "nonce 4 is not current (5)", /went through first.*fresh quote/i],
    ["wrong account selected", "signature does not recover to the expected signer", /different account/i],
    ["dishonest relayer", "relayer returned a permit that does not match the request (recipient)", /refused.*different relayer/i],
    ["relayer unreachable", "TypeError: Failed to fetch", /Could not reach the relayer/i],
    ["bad address", "InvalidTronAddressError: bad checksum", /not a valid Tron address/i],
  ];

  for (const [name, raw, expected] of cases) {
    it(`explains ${name}`, () => {
      const msg = explain(new Error(raw));
      expect(msg).toMatch(expected);
      // No jargon or stack noise should survive into the UI.
      expect(msg).not.toMatch(/0x[0-9a-f]{20,}|Error:|TypeError|undefined/);
    });
  }

  it("passes through an unrecognized message rather than inventing one", () => {
    expect(explain(new Error("something specific and new"))).toBe("something specific and new");
  });
});

describe("recipient validation", () => {
  it("accepts a valid base58 Tron address", () => {
    const r = validateRecipient(" TNah4x36PRtF3R8tFfPxZCsdYvYYVzg6gw ");
    expect(r.ok).toBe(true);
  });

  it("refuses an Ethereum-style address — it IS a valid Tron address and would burn the funds", () => {
    const r = validateRecipient("0x1234567890123456789012345678901234567890");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/Ethereum-style.*start with T.*permanently/i);
  });

  it("refuses 41-hex and malformed base58", () => {
    expect(validateRecipient("41a614f803b6fd780986a42c78ec9c7f77e6ded13c").ok).toBe(false);
    expect(validateRecipient("TNah4x36PRtF3R8tFfPxZCsdYvYYVzg6gX").ok).toBe(false); // bad checksum
    expect(validateRecipient("").ok).toBe(false);
  });
});

describe("sponsorship", () => {
  it("tells the user a lapsed sponsorship is not a lost transfer", () => {
    const m = explain(new Error("sponsorship declined: this policy has reached its spending limit; request a new quote"));
    expect(m).toMatch(/you can still send it yourself/i);
    // The raw reason is a developer's, not a user's.
    expect(m).not.toMatch(/policy/i);
  });
});

