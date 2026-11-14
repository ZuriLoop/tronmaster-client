import { type Hex, getContractAddress, keccak256, numberToHex } from "viem";
import { sign } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import {
  EVM_CREATE2_PREFIX,
  TronRpc,
  TronRpcError,
  base58Decode,
  base58Encode,
  buildPermit,
  computeCreate2Address,
  computeProtocolFee,
  decodeRevert,
  getPermitDigest,
  getPermitTypedData,
  normalizeSignature,
  parseTronAddress,
  toBase58,
  toTronHex,
} from "../src/index.js";
import { encodeErrorResult } from "viem";
import { permitAccountAbi } from "../src/abi.js";
import { hashTypedData } from "viem";

const rnd = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const hex = (b: Uint8Array) => `0x${[...b].map((x) => x.toString(16).padStart(2, "0")).join("")}` as Hex;
const RUNS = 300;

describe("property: addresses", () => {
  it("base58 round-trips arbitrary bytes, including leading zeros", () => {
    for (let i = 0; i < RUNS; i++) {
      const b = rnd(1 + (i % 40));
      if (i % 7 === 0) b[0] = 0;
      expect([...base58Decode(base58Encode(b))]).toEqual([...b]);
    }
  });

  it("every 20-byte address round-trips through base58 and 41-hex", () => {
    for (let i = 0; i < RUNS; i++) {
      const a = hex(rnd(20)).toLowerCase();
      const b58 = toBase58(a);
      expect(b58).toMatch(/^T[1-9A-HJ-NP-Za-km-z]{33}$/);
      expect(parseTronAddress(b58)).toBe(a);
      expect(parseTronAddress(toTronHex(a))).toBe(a);
    }
  });

  it("any single-character change to a base58 address fails the checksum", () => {
    const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    for (let i = 0; i < RUNS; i++) {
      const b58 = toBase58(hex(rnd(20)));
      const pos = 1 + (i % 33);
      const c = alphabet[(alphabet.indexOf(b58[pos]!) + 1 + (i % 57)) % 58]!;
      const mutated = b58.slice(0, pos) + c + b58.slice(pos + 1);
      if (mutated === b58) continue;
      expect(() => parseTronAddress(mutated)).toThrow();
    }
  });
});

describe("property: CREATE2", () => {
  it("with the EVM prefix, matches viem's independent CREATE2 implementation", () => {
    for (let i = 0; i < RUNS; i++) {
      const deployer = hex(rnd(20));
      const salt = hex(rnd(32));
      const bytecode = hex(rnd(1 + (i % 100)));
      const ours = computeCreate2Address({ deployer, salt, initCodeHash: keccak256(bytecode), prefix: EVM_CREATE2_PREFIX });
      const theirs = getContractAddress({ opcode: "CREATE2", from: deployer, salt, bytecode });
      expect(ours).toBe(theirs.toLowerCase());
    }
  });
});

describe("property: fees", () => {
  it("matches min(floor(value*bps/1e4), cap) for the fee token, 0 otherwise", () => {
    const token = toBase58(hex(rnd(20)));
    for (let i = 0; i < RUNS; i++) {
      const value = BigInt(hex(rnd(1 + (i % 16))));
      const bps = i % 51;
      const cap = BigInt(hex(rnd(4)));
      const fee = computeProtocolFee({ feeToken: token, bps, cap }, token, value);
      const ref = bps === 0 || cap === 0n ? 0n : (value * BigInt(bps)) / 10_000n < cap ? (value * BigInt(bps)) / 10_000n : cap;
      expect(fee).toBe(ref);
      expect(computeProtocolFee({ feeToken: token, bps, cap }, toBase58(hex(rnd(20))), value)).toBe(0n);
    }
  });
});

describe("property: permits and signatures", () => {
  it("typed data hashed by viem equals getPermitDigest for random permits", () => {
    for (let i = 0; i < 100; i++) {
      const permit = buildPermit({
        token: hex(rnd(20)),
        owner: hex(rnd(20)),
        to: hex(rnd(20)),
        value: BigInt(hex(rnd(1 + (i % 32)))) + 1n,
        maxFee: BigInt(hex(rnd(8))),
        relayer: i % 3 === 0 ? undefined : hex(rnd(20)),
        nonce: BigInt(i),
        deadline: 2_000_000_000 + i,
        now: 2_000_000_000 - 60,
      });
      const ctx = { account: hex(rnd(20)), chainId: i % 2 ? 728126428 : 3448148188 };
      const td = getPermitTypedData(permit, ctx);
      const { EIP712Domain: _, ...types } = td.types;
      expect(hashTypedData({ domain: td.domain, types, primaryType: td.primaryType, message: td.message as never })).toBe(
        getPermitDigest(permit, ctx),
      );
    }
  });

  it("normalizeSignature accepts every valid viem signature and its v=0/1 form", async () => {
    for (let i = 0; i < 100; i++) {
      const key = hex(rnd(32));
      const sig = (await sign({ hash: hex(rnd(32)), privateKey: key, to: "hex" })) as Hex;
      const n = normalizeSignature(sig);
      const v01 = `${sig.slice(0, 130)}${(Number.parseInt(sig.slice(130), 16) - 27).toString(16).padStart(2, "0")}` as Hex;
      expect(normalizeSignature(v01)).toEqual(n);
      expect(BigInt(n.vs) >> 255n).toBe(BigInt(n.v - 27));
    }
  });
});

describe("TronRpc resilience", () => {
  it("retries 429/5xx and succeeds", async () => {
    let n = 0;
    const fetchMock = vi.fn(async () => {
      n++;
      if (n < 3) return new Response("rate limited", { status: n === 1 ? 429 : 503 });
      return new Response(JSON.stringify({ blockID: `${"00".repeat(28)}2b6653dc` }));
    });
    const rpc = new TronRpc({ url: "https://node.example", fetch: fetchMock as never });
    expect(await rpc.getChainId()).toBe(728126428);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("never retries a broadcast or a 4xx", async () => {
    const fetchMock = vi.fn(async () => new Response("busy", { status: 503 }));
    const rpc = new TronRpc({ url: "https://node.example", fetch: fetchMock as never });
    await expect(rpc.broadcast({ txID: "aa", raw_data: { contract: [] }, raw_data_hex: "" })).rejects.toThrow(TronRpcError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const f400 = vi.fn(async () => new Response("bad", { status: 400 }));
    await expect(new TronRpc({ url: "https://n", fetch: f400 as never }).getChainId()).rejects.toThrow();
    expect(f400).toHaveBeenCalledTimes(1);
  });

  it("decodes contract custom errors from revert data", () => {
    expect(decodeRevert(encodeErrorResult({ abi: permitAccountAbi, errorName: "BadNonce" }))).toBe("BadNonce");
    expect(decodeRevert(encodeErrorResult({ abi: permitAccountAbi, errorName: "InsufficientAvailable" }).slice(2))).toBe(
      "InsufficientAvailable",
    );
    expect(decodeRevert("0x12")).toBeUndefined();
  });
});

void numberToHex;
