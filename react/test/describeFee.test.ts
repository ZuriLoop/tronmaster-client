/**
 * The line under the fee. It exists because a fee is almost entirely energy,
 * and the price of energy moves hour to hour — the same transfer was quoted
 * at 6.91, 3.41, 0.72 and 1.00 USDT within an hour while this was built, with
 * nothing on the page to explain any of it.
 *
 * What it must never do is claim more than is known. A relayer reports the
 * basis it PRICED on; the chain fuses own stake and every delegation into one
 * balance, so "this transfer was served by X" is not a fact anyone has.
 */
import { describe, expect, it } from "vitest";
import { describeFee } from "../src/useTransfer.js";

describe("describeFee", () => {
  const cases: Array<[string, Parameters<typeof describeFee>[0], RegExp | undefined]> = [
    ["cost-plus names the rate and the margin", { feeBasis: "cost-plus", energyPriceSun: 16n, sponsored: false }, /energy costs, at 16 sun per energy, plus the relayer's margin/],
    ["the floor says it is a minimum, not a cost", { feeBasis: "floor", energyPriceSun: 16n, sponsored: false }, /minimum fee — energy is 16 sun per energy/],
    ["the stake tier is a flat rate", { feeBasis: "stake-flat", energyPriceSun: 13n, sponsored: false }, /flat rate, served from the relayer's own staked energy/],
    ["a basis with no rate still explains itself", { feeBasis: "cost-plus", sponsored: false }, /energy costs, plus the relayer's margin/],
    ["a rate with no basis still says something true", { energyPriceSun: 100n, sponsored: false }, /energy is 100 sun per energy right now/],
    ["a relayer that reports nothing produces no line", { sponsored: false }, undefined],
    ["sponsored transfers defer to the sponsored note", { feeBasis: "cost-plus", energyPriceSun: 16n, sponsored: true }, undefined],
  ];

  for (const [name, quote, expected] of cases) {
    it(name, () => {
      const line = describeFee(quote);
      if (expected === undefined) {
        expect(line).toBeUndefined();
        return;
      }
      expect(line).toMatch(expected);
      // The same guard explain.test.ts applies: nothing raw reaches a user.
      expect(line).not.toMatch(/0x[0-9a-f]{20,}|undefined|NaN|\[object/);
    });
  }

  it("never claims a transfer was served from a particular source", () => {
    // Quote time knows the pricing basis, not the spend. Wording that implies
    // otherwise would be a claim the chain cannot support.
    for (const basis of ["cost-plus", "stake-flat", "floor"] as const) {
      const line = describeFee({ feeBasis: basis, energyPriceSun: 20n, sponsored: false }) ?? "";
      expect(line).not.toMatch(/was served|paid for by|came from/);
    }
  });
});
