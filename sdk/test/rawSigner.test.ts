import { keccak256, sha256, toHex } from "viem";
import { privateKeyToAccount, sign } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { extractSignature, signTransaction, toTronHex, tronSignerFromPrivateKey } from "../src/index.js";

describe("signed-transaction protobuf parsing", () => {
  const key = keccak256(toHex("protobuf-key"));
  const raw = "0a02abcd2208000000000000000040e0a7b1d806";
  const sig = "11".repeat(65);
  it("extracts the signature and checks raw_data", () => {
    const signed = `0a${(raw.length / 2).toString(16).padStart(2, "0")}${raw}1241${sig}`;
    expect(extractSignature(signed, raw)).toBe(sig);
    expect(() => extractSignature(signed, `${raw}00`)).toThrow(/differs/);
    expect(() => extractSignature(`${signed}1241${sig}`, raw)).toThrow(/exactly one/);
    expect(() => extractSignature(signed.slice(0, -10), raw)).toThrow();
  });
  it("rejects a remote signer whose signature recovers to someone else", async () => {
    const signer = tronSignerFromPrivateKey(key);
    const other = keccak256(toHex("other"));
    // A well-formed TriggerSmartContract (the bytes must pass verifyTransaction first).
    const vi = (n: bigint | number) => {
      let v = BigInt(n);
      let out = "";
      do {
        let b = Number(v & 0x7fn);
        v >>= 7n;
        if (v) b |= 0x80;
        out += b.toString(16).padStart(2, "0");
      } while (v);
      return out;
    };
    const ld = (f: number, hex: string) => `${vi((f << 3) | 2)}${vi(hex.length / 2)}${hex}`;
    const tsc = ld(1, toTronHex(signer.address).toLowerCase()) + ld(2, toTronHex("0x1111111111111111111111111111111111111111").toLowerCase());
    const any = ld(1, Buffer.from("type.googleapis.com/protocol.TriggerSmartContract").toString("hex")) + ld(2, tsc);
    const raw = `0a02abcd2208${"00".repeat(8)}40${vi(Date.now() + 60_000)}${ld(11, `08${vi(31)}${ld(2, any)}`)}`;
    const tx = {
      txID: sha256(`0x${raw}`).slice(2),
      raw_data_hex: raw,
      raw_data: { contract: [{ type: "TriggerSmartContract", parameter: { value: { owner_address: toTronHex(signer.address), contract_address: toTronHex("0x1111111111111111111111111111111111111111"), data: "" } } }] },
    };
    const bad = {
      address: signer.address,
      signRawTransaction: async () => (await sign({ hash: `0x${tx.txID}`, privateKey: other, to: "hex" })).slice(2),
    };
    await expect(
      signTransaction(tx, bad, { type: "TriggerSmartContract", from: signer.address, to: "0x1111111111111111111111111111111111111111", data: "0x" }),
    ).rejects.toThrow(/recover/);
    expect(privateKeyToAccount(key).address.toLowerCase()).toBe(signer.address);
  });
});

