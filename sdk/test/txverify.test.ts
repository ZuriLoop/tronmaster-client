import { type Hex, sha256 } from "viem";
import { describe, expect, it } from "vitest";
import {
  ContractType,
  type ExpectedCall,
  type TronTransaction,
  decodeTransactionRaw,
  parseTronAddress,
  signTransaction,
  toTronHex,
  tronSignerFromPrivateKey,
  verifyTransaction,
} from "../src/index.js";

// ------------------------------------------------- tiny protobuf encoder

const varint = (n: bigint | number) => {
  let v = BigInt(n);
  let s = "";
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v) b |= 0x80;
    s += b.toString(16).padStart(2, "0");
  } while (v);
  return s;
};
const tag = (f: number, w: number) => varint((f << 3) | w);
const vint = (f: number, n: bigint | number) => tag(f, 0) + varint(n);
const bytes = (f: number, hex: string) => tag(f, 2) + varint(hex.length / 2) + hex;
const str = (f: number, s: string) => bytes(f, Buffer.from(s).toString("hex"));

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const signer = tronSignerFromPrivateKey(KEY);
const OWNER = toTronHex(signer.address).toLowerCase();
const TARGET = toTronHex(parseTronAddress("TEZgEJXDosFmTPMUgHpT3bv1J1dXhGLqtp")).toLowerCase();
const OTHER = toTronHex(parseTronAddress("TNah4x36PRtF3R8tFfPxZCsdYvYYVzg6gw")).toLowerCase();
const DATA = "a9059cbb" + "00".repeat(12) + OTHER.slice(2) + "00".repeat(31) + "01";
const NOW = 1_800_000_000_000;

interface Opts {
  type?: number;
  typeUrl?: string;
  owner?: string;
  to?: string;
  data?: string;
  value?: bigint;
  tokenValue?: bigint;
  permissionId?: number;
  extraContract?: boolean;
  feeLimit?: bigint;
  expiration?: number;
  memo?: string;
}

function trigger(o: Opts = {}) {
  return (
    bytes(1, o.owner ?? OWNER) +
    bytes(2, o.to ?? TARGET) +
    (o.value ? vint(3, o.value) : "") +
    bytes(4, o.data ?? DATA) +
    (o.tokenValue ? vint(5, o.tokenValue) + vint(6, 1000001) : "")
  );
}
function contract(o: Opts, inner: string) {
  const type = o.type ?? ContractType.TriggerSmartContract;
  const url = o.typeUrl ?? `type.googleapis.com/protocol.${type === 1 ? "TransferContract" : type === 30 ? "CreateSmartContract" : "TriggerSmartContract"}`;
  return bytes(11, vint(1, type) + bytes(2, str(1, url) + bytes(2, inner)) + (o.permissionId ? vint(5, o.permissionId) : ""));
}
function raw(o: Opts = {}, inner = trigger(o)) {
  return (
    bytes(1, "abcd") +
    bytes(4, "0011223344556677") +
    vint(8, o.expiration ?? NOW + 60_000) +
    (o.memo ? bytes(10, o.memo) : "") +
    contract(o, inner) +
    (o.extraContract ? contract(o, inner) : "") +
    vint(14, NOW) +
    (o.feeLimit === 0n ? "" : vint(18, o.feeLimit ?? 100_000_000n))
  );
}
/** Wraps raw bytes with an honest-looking JSON view of the *intended* call. */
function tx(rawHex: string): TronTransaction {
  return {
    txID: sha256(`0x${rawHex}`).slice(2),
    raw_data_hex: rawHex,
    raw_data: {
      contract: [
        {
          type: "TriggerSmartContract",
          parameter: { value: { owner_address: OWNER, contract_address: TARGET, data: DATA, call_value: 0 } },
        },
      ],
    },
  };
}

const want: ExpectedCall = { type: "TriggerSmartContract", from: signer.address, to: TARGET, data: `0x${DATA}`, maxFeeLimit: 100_000_000n };

describe("decodeTransactionRaw", () => {
  it("decodes a TriggerSmartContract", () => {
    const d = decodeTransactionRaw(raw());
    expect(d.contracts).toHaveLength(1);
    expect(d.contracts[0]).toMatchObject({ type: 31, owner: OWNER, to: TARGET, data: DATA, value: 0n });
    expect(d.feeLimit).toBe(100_000_000n);
    expect(d.expiration).toBe(BigInt(NOW + 60_000));
  });

  it("rejects truncated and malformed input", () => {
    expect(() => decodeTransactionRaw(raw().slice(0, -4))).toThrow();
    expect(() => decodeTransactionRaw("zz")).toThrow(/hex/);
    expect(() => decodeTransactionRaw(`${raw()}${bytes(9, "00")}`)).toThrow(/auths/);
    expect(() => decodeTransactionRaw(`${raw()}${vint(99, 1)}`)).toThrow(/unexpected field/);
  });

  it("rejects a non-21-byte address", () => {
    expect(() => decodeTransactionRaw(raw({ to: "41" + "00".repeat(19) }))).toThrow(/21-byte/);
  });

  it("decodes a TransferContract and a CreateSmartContract", () => {
    const transfer = raw({ type: 1, feeLimit: 0n }, bytes(1, OWNER) + bytes(2, OTHER) + vint(3, 5_000_000));
    expect(decodeTransactionRaw(transfer).contracts[0]).toMatchObject({ type: 1, to: OTHER, value: 5_000_000n });
    const sc = bytes(1, OWNER) + str(3, "abi-json-ish") + bytes(4, "6080604052") + vint(6, 100) + str(7, "PaymasterFactory") + vint(8, 10_000_000);
    const create = raw({ type: 30 }, bytes(1, OWNER) + bytes(2, sc));
    expect(decodeTransactionRaw(create).contracts[0]!.create).toMatchObject({
      origin: OWNER,
      bytecode: "6080604052",
      consumeUserResourcePercent: 100n,
      name: "PaymasterFactory",
    });
  });
});

describe("verifyTransaction (bytes, not JSON)", () => {
  it("accepts the intended call", () => {
    expect(() => verifyTransaction(tx(raw()), want, NOW)).not.toThrow();
  });

  // In each case the JSON is honest and only the signed bytes are malicious.
  const attacks: Array<[string, Opts, RegExp]> = [
    ["different contract", { to: OTHER }, /contract mismatch/],
    ["different calldata", { data: `${DATA.slice(0, -2)}ff` }, /calldata mismatch/],
    ["added call value", { value: 1_000_000n }, /call value mismatch/],
    ["TRC-10 token value", { tokenValue: 1n }, /TRC-10/],
    ["different owner", { owner: OTHER }, /owner/],
    ["second contract", { extraContract: true }, /exactly one contract/],
    ["non-owner permission", { permissionId: 2 }, /Permission_id/],
    ["inflated fee_limit", { feeLimit: 15_000_000_000n }, /fee_limit/],
    ["far-future expiration", { expiration: NOW + 86_400_000 }, /expiration/],
    ["memo", { memo: "deadbeef" }, /memo/],
    ["wrong contract type", { type: 1 }, /contract type|TransferContract/],
    ["spoofed type_url", { typeUrl: "type.googleapis.com/protocol.TransferContract" }, /type_url/],
  ];
  for (const [name, o, err] of attacks) {
    it(`rejects ${name}`, () => {
      expect(() => verifyTransaction(tx(raw(o)), want, NOW)).toThrow(err);
    });
  }

  it("rejects a txID that does not hash the bytes", () => {
    expect(() => verifyTransaction({ ...tx(raw()), txID: "00".repeat(32) }, want, NOW)).toThrow(/txID/);
  });

  it("checks deploy bytecode and resource percent", () => {
    const sc = (code: string, pct: number) => bytes(1, OWNER) + bytes(4, code) + vint(6, pct);
    const exp: ExpectedCall = { type: "CreateSmartContract", from: signer.address, bytecode: "0x6080", consumeUserResourcePercent: 100 };
    const ok = tx(raw({ type: 30 }, bytes(1, OWNER) + bytes(2, sc("6080", 100))));
    expect(() => verifyTransaction(ok, exp, NOW)).not.toThrow();
    expect(() => verifyTransaction(tx(raw({ type: 30 }, bytes(1, OWNER) + bytes(2, sc("6081", 100)))), exp, NOW)).toThrow(/bytecode/);
    expect(() => verifyTransaction(tx(raw({ type: 30 }, bytes(1, OWNER) + bytes(2, sc("6080", 0)))), exp, NOW)).toThrow(/resource/);
  });

  it("signTransaction never calls the signer for a forged transaction", async () => {
    let called = false;
    const spy = { address: signer.address, signTransactionId: async (id: Hex) => ((called = true), signer.signTransactionId!(id)) };
    await expect(signTransaction(tx(raw({ to: OTHER, expiration: Date.now() + 60_000 })), spy, want)).rejects.toThrow(/contract mismatch/);
    expect(called).toBe(false);
    const good = await signTransaction(tx(raw({ expiration: Date.now() + 60_000 })), spy, want);
    expect(called).toBe(true);
    expect(good.signature?.[0]).toMatch(/^[0-9a-f]{130}$/);
  });
});

describe("signature normalization for broadcast", () => {
  it("a signer returning yParity 0/1 still broadcasts v 27/28", async () => {
    const want: ExpectedCall = { ...wantFresh(), maxExpiryMs: 120_000 };
    const raw = tx(raw27());
    const yParity = {
      address: signer.address,
      signTransactionId: async (id: `0x${string}`) => {
        const s = await signer.signTransactionId!(id);
        const v = Number.parseInt(s.slice(-2), 16); // 27/28 from the local key
        return `${s.slice(0, -2)}${(v - 27).toString(16).padStart(2, "0")}` as `0x${string}`;
      },
    };
    const signed = await signTransaction(raw, yParity, want);
    const vByte = Number.parseInt(signed.signature![0]!.slice(128), 16);
    expect([27, 28]).toContain(vByte); // java-tron rejects 0/1
  });
});

const raw27 = () => raw({ expiration: Date.now() + 60_000 });
const wantFresh = (): ExpectedCall => ({ type: "TriggerSmartContract", from: signer.address, to: TARGET, data: `0x${DATA}`, maxFeeLimit: 100_000_000n });

describe("stake 2.0 contracts", () => {
  const FREEZE_URL = "type.googleapis.com/protocol.FreezeBalanceV2Contract";
  const freezeBody = (amount: number, resource?: number) => bytes(1, OWNER) + vint(2, amount) + (resource ? vint(3, resource) : "");
  const freezeRaw = (o: Opts = {}, amount = 5_000_000, resource?: number) =>
    raw({ type: 54, typeUrl: FREEZE_URL, feeLimit: 0n, ...o }, freezeBody(amount, resource));
  const want: ExpectedCall = { type: "FreezeBalanceV2", from: signer.address, amount: 5_000_000n, resource: "ENERGY" };

  it("accepts a faithful freeze and decodes the resource", () => {
    const d = verifyTransaction(tx(freezeRaw({}, 5_000_000, 1)), want, NOW);
    expect(d.contracts[0]).toMatchObject({ type: 54, value: 5_000_000n, resource: 1 });
  });

  it("rejects amount, resource, fee_limit and unknown-resource tampering", () => {
    // bytes say 6 TRX while the request said 5
    expect(() => verifyTransaction(tx(freezeRaw({}, 6_000_000, 1)), want, NOW)).toThrow(/amount/);
    // bytes stake for bandwidth (field absent = 0) while the request said energy
    expect(() => verifyTransaction(tx(freezeRaw()), want, NOW)).toThrow(/resource/);
    // a system contract must not carry a fee_limit
    expect(() => verifyTransaction(tx(freezeRaw({ feeLimit: 100_000_000n }, 5_000_000, 1)), want, NOW)).toThrow(/fee_limit/);
    // resource code outside the enum
    expect(() => verifyTransaction(tx(freezeRaw({}, 5_000_000, 7)), want, NOW)).toThrow(/unknown resource/);
    // freeze bytes cannot satisfy an unfreeze request (type_url pinned per type)
    expect(() => verifyTransaction(tx(freezeRaw({}, 5_000_000, 1)), { ...want, type: "UnfreezeBalanceV2" }, NOW)).toThrow(/contract type|type_url/);
  });

  it("verifies WithdrawExpireUnfreeze and rejects extra fields", () => {
    const url = "type.googleapis.com/protocol.WithdrawExpireUnfreezeContract";
    const w: ExpectedCall = { type: "WithdrawExpireUnfreeze", from: signer.address };
    expect(() => verifyTransaction(tx(raw({ type: 56, typeUrl: url, feeLimit: 0n }, bytes(1, OWNER))), w, NOW)).not.toThrow();
    expect(() => verifyTransaction(tx(raw({ type: 56, typeUrl: url, feeLimit: 0n }, bytes(1, OWNER) + vint(2, 1))), w, NOW)).toThrow(/unexpected field/);
  });
});
