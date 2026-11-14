import { readFileSync } from "node:fs";
import { type Hex, keccak256, numberToHex, sha256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import {
  EVM_CREATE2_PREFIX,
  InvalidTronAddressError,
  ZERO_ADDRESS,
  assertPermit,
  buildPermit,
  computeProtocolFee,
  createRelayerClient,
  deriveDepositSalt,
  deserializePermit,
  encodePermitTransfer,
  encodePermitTransferPacked,
  formatUnits,
  fromDigestSigner,
  fromEip1193,
  fromPrivateKey,
  getAccountSalt,
  getCloneInitCode,
  getForwarderAddress,
  getForwarderArgs,
  getPermitAccountAddress,
  getPermitDigest,
  getPermitTypedData,
  normalizeSignature,
  parseTronAddress,
  parseUnits,
  serializePermit,
  signPermit,
  signTransaction,
  toBase58,
  toTronHex,
  tronSignerFromPrivateKey,
  verifyPermitSignature,
} from "../src/index.js";

const v = JSON.parse(readFileSync(new URL("../vectors/vectors.json", import.meta.url), "utf8"));

describe("addresses", () => {
  it("round-trips vector addresses", () => {
    for (const a of v.addresses) {
      expect(parseTronAddress(a.base58)).toBe(a.hex);
      expect(parseTronAddress(a.tronHex)).toBe(a.hex);
      expect(parseTronAddress(a.hex.toUpperCase().replace("0X", "0x"))).toBe(a.hex);
      expect(toBase58(a.hex)).toBe(a.base58);
      expect(toTronHex(a.base58)).toBe(a.tronHex);
    }
  });

  it("rejects bad checksums, prefixes and formats", () => {
    const usdt = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
    const flipped = `${usdt.slice(0, -1)}${usdt.endsWith("t") ? "u" : "t"}`;
    expect(() => parseTronAddress(flipped)).toThrow(InvalidTronAddressError);
    expect(() => parseTronAddress("0x1234")).toThrow(InvalidTronAddressError);
    expect(() => parseTronAddress("42a614f803b6fd780986a42c78ec9c7f77e6ded13c")).toThrow();
    expect(() => parseTronAddress("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6O")).toThrow(); // 'O' not base58
    expect(() => parseTronAddress("")).toThrow();
  });
});

describe("create2", () => {
  it("matches forwarder vectors (EVM prefix checked by Foundry too)", () => {
    for (const f of v.forwarders) {
      const p = { factory: v.factory, forwarderRouter: v.evmForwarderRouter, treasury: f.treasury, sweeper: f.sweeper, salt: f.salt };
      expect(getForwarderAddress({ ...p, prefix: EVM_CREATE2_PREFIX })).toBe(f.evm);
      expect(getForwarderAddress(p)).toBe(f.tron);
      expect(getCloneInitCode(v.evmForwarderRouter, getForwarderArgs(f.treasury, f.sweeper))).toBe(f.initCode);
    }
  });

  it("matches account vectors", () => {
    for (const a of v.accounts) {
      const p = { factory: v.factory, accountRouter: v.evmAccountRouter, owner: a.owner, index: BigInt(a.index) };
      expect(getPermitAccountAddress(p)).toBe(a.tron);
      expect(getPermitAccountAddress({ ...p, prefix: EVM_CREATE2_PREFIX })).toBe(a.evm);
      expect(getAccountSalt(a.owner, BigInt(a.index))).toBe(a.salt);
    }
  });

  it("tron and evm prefixes give different addresses", () => {
    const f = v.forwarders[0];
    expect(f.tron).not.toBe(f.evm);
  });

  it("derives deterministic, secret-dependent deposit salts", async () => {
    const secret = "a-very-long-test-secret-0123456789";
    const a = await deriveDepositSalt(secret, "user-1");
    expect(a).toBe(await deriveDepositSalt(secret, "user-1"));
    expect(a).not.toBe(await deriveDepositSalt(secret, "user-2"));
    expect(a).not.toBe(await deriveDepositSalt(`${secret}x`, "user-1"));
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
    await expect(deriveDepositSalt("short", "x")).rejects.toThrow();
  });
});

describe("permits", () => {
  const base = {
    token: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
    owner: v.owner,
    to: "0x1111111111111111111111111111111111111111",
    value: 1n,
    maxFee: 1n,
    nonce: 0n,
    now: 1_000,
  };

  it("matches permit vectors", () => {
    for (const p of v.permits) {
      const permit = deserializePermit(p.permit);
      expect(getPermitDigest(permit, { account: p.account, chainId: p.chainId })).toBe(p.digest);
    }
  });

  it("rejects plain objects and wallet JSON", () => {
    const permit = buildPermit(base);
    const td = getPermitTypedData(permit, { account: v.accounts[0].evm, chainId: 728126428 }, { addressFormat: "base58" });
    expect(() => getPermitDigest(td.message as never, { account: v.accounts[0].evm, chainId: 1 })).toThrow(TypeError);
    expect(() => getPermitDigest({ ...permit } as never, { account: v.accounts[0].evm, chainId: 1 })).toThrow(TypeError);
    expect(() => assertPermit(permit)).not.toThrow();
    expect(Object.isFrozen(permit)).toBe(true);
  });

  it("enforces deadline policy", () => {
    expect(buildPermit(base).deadline).toBe(1_180n);
    const warn = vi.fn();
    buildPermit({ ...base, ttlSeconds: 3_600, onWarning: warn });
    expect(warn).toHaveBeenCalledOnce();
    expect(() => buildPermit({ ...base, ttlSeconds: 90_000 })).toThrow(/24h/);
    expect(buildPermit({ ...base, ttlSeconds: 90_000, allowLongDeadline: true, onWarning: () => {} }).deadline).toBe(91_000n);
    expect(() => buildPermit({ ...base, deadline: 999 })).toThrow(/past/);
    expect(() => buildPermit({ ...base, value: 0n })).toThrow();
    expect(() => buildPermit({ ...base, to: ZERO_ADDRESS })).toThrow();
  });

  it("base58 typed data has base58 addresses; hex has hex", () => {
    const permit = buildPermit(base);
    const ctx = { account: v.accounts[0].evm, chainId: 728126428 };
    expect(getPermitTypedData(permit, ctx, { addressFormat: "base58" }).message.token).toBe(base.token);
    expect(getPermitTypedData(permit, ctx).message.token).toBe(parseTronAddress(base.token));
  });

  it("serializes and deserializes losslessly", () => {
    const permit = buildPermit({ ...base, value: 2n ** 200n });
    expect(serializePermit(deserializePermit(serializePermit(permit)))).toEqual(serializePermit(permit));
  });
});

describe("signing", () => {
  const key = v.testKey as Hex;
  const ctx = { account: v.permits[0].account, chainId: v.permits[0].chainId };
  const permit = deserializePermit(v.permits[0].permit);

  it("reproduces vector signatures and verifies", async () => {
    const sig = await signPermit(fromPrivateKey(key), permit, ctx);
    expect(sig.r).toBe(v.permits[0].r);
    expect(sig.vs).toBe(v.permits[0].vs);
    expect(await verifyPermitSignature(permit, ctx, sig)).toBe(true);
  });

  it("works with a typed-data-only signer", async () => {
    const acct = privateKeyToAccount(key);
    const signer = { address: parseTronAddress(acct.address), signTypedData: (td: never) => acct.signTypedData(td) };
    const sig = await signPermit(signer as never, permit, ctx);
    expect(sig.vs).toBe(v.permits[0].vs);
  });

  it("accepts v=0/1 and {r,s,v} from digest signers", async () => {
    const acct = privateKeyToAccount(key);
    const signer = fromDigestSigner({
      address: acct.address,
      sign: async (d) => {
        const s = (await acct.sign({ hash: d })) as string;
        return { r: `0x${s.slice(2, 66)}` as Hex, s: `0x${s.slice(66, 130)}` as Hex, v: Number.parseInt(s.slice(130), 16) - 27 };
      },
    });
    expect((await signPermit(signer, permit, ctx)).vs).toBe(v.permits[0].vs);
  });

  it("rejects the wrong key before submission", async () => {
    await expect(signPermit(fromPrivateKey(keccak256(toHex("other"))), permit, ctx)).rejects.toThrow(/recover/);
  });

  it("rejects high-s", () => {
    const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const s = BigInt(v.permits[0].s);
    const sig = `${v.permits[0].r}${numberToHex(n - s, { size: 32 }).slice(2)}1b` as Hex;
    expect(() => normalizeSignature(sig)).toThrow(/malleable/);
  });

  it("encodes permitTransfer calldata", async () => {
    const sig = await signPermit(fromPrivateKey(key), permit, ctx);
    const data = encodePermitTransfer({ permit, signature: sig, relayerFee: 5n, feeRecipient: permit.relayer });
    expect(data.slice(0, 10)).toMatch(/^0x[0-9a-f]{8}$/);
    expect(data).toContain(sig.r.slice(2));
  });
});

describe("fees and units", () => {
  const usdt = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
  it("mirrors the contract fee formula", () => {
    const cfg = { feeToken: usdt, bps: 10, cap: 250_000n };
    expect(computeProtocolFee(cfg, usdt, 10_000_000n)).toBe(10_000n);
    expect(computeProtocolFee(cfg, usdt, 10_000_000_000n)).toBe(250_000n);
    expect(computeProtocolFee(cfg, "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf", 10_000_000n)).toBe(0n);
    expect(computeProtocolFee({ ...cfg, feeToken: ZERO_ADDRESS }, usdt, 10n ** 12n)).toBe(0n);
    expect(computeProtocolFee(cfg, usdt, 999n)).toBe(0n); // rounds down
  });
  it("parses and formats units", () => {
    expect(parseUnits("1.5", 6)).toBe(1_500_000n);
    expect(parseUnits("0.000001", 6)).toBe(1n);
    expect(() => parseUnits("0.0000001", 6)).toThrow();
    expect(() => parseUnits("-1", 6)).toThrow();
    expect(formatUnits(1_500_000n, 6)).toBe("1.5");
    expect(formatUnits(1n, 6)).toBe("0.000001");
  });
});

// Transaction signing is covered byte-for-byte in txverify.test.ts.

describe("relayer client", () => {
  it("falls back on 5xx and does not retry 4xx", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      calls.push(url);
      if (url.startsWith("https://a")) return new Response("{}", { status: 503 });
      if (url.includes("/v1/status/bad")) return new Response(JSON.stringify({ error: "nope" }), { status: 400 });
      return new Response(JSON.stringify({ relayer: ZERO_ADDRESS, chainId: 1, factory: ZERO_ADDRESS, tokens: [], version: "1" }));
    });
    const c = createRelayerClient({ url: ["https://a.example", "https://b.example"], fetch: fetchMock as never });
    const info = await c.info();
    expect(info.version).toBe("1");
    expect(calls).toEqual(["https://a.example/v1/info", "https://b.example/v1/info"]);
    await expect(c.status("bad")).rejects.toThrow("nope");
  });
});

describe("relayer client: quote verification", () => {
  const OWNER = "0x1000000000000000000000000000000000000001";
  const TOKEN = "0x1000000000000000000000000000000000000002";
  const TO = "0x1000000000000000000000000000000000000003";
  const RELAYER = parseTronAddress("0x1000000000000000000000000000000000000004");

  function quoteResponse(tamper: Partial<Record<string, unknown>> = {}, feeFields?: { relayerFee?: string; nonce?: string }) {
    const permit = {
      token: parseTronAddress(TOKEN),
      owner: parseTronAddress(OWNER),
      to: parseTronAddress(TO),
      value: "1000000",
      maxFee: "300000",
      relayer: RELAYER,
      deadline: String(Math.floor(Date.now() / 1000) + 180),
      nonce: "7",
      ...tamper,
    };
    return {
      relayer: RELAYER,
      relayerFee: feeFields?.relayerFee ?? "200000",
      protocolFee: "100000",
      maxFee: "300000",
      account: parseTronAddress("0x1000000000000000000000000000000000000005"),
      nonce: feeFields?.nonce ?? "7",
      deadline: permit.deadline,
      chainId: 728126428,
      factory: parseTronAddress("0x1000000000000000000000000000000000000006"),
      permit,
      quoteId: "q.q",
      expiresAt: Math.floor(Date.now() / 1000) + 60,
    };
  }

  const clientFor = (body: unknown) =>
    createRelayerClient({
      url: "https://r.example",
      fetch: (async () => new Response(JSON.stringify(body))) as never,
    });

  const request = { owner: OWNER, token: TOKEN, to: TO, value: 1_000_000n };

  it("accepts a faithful quote", async () => {
    const q = await clientFor(quoteResponse()).quote(request);
    expect(q.unsignedPermit.maxFee).toBe(300000n);
  });

  it("rejects a permit that differs from the request or quote", async () => {
    const cases: Array<[Record<string, unknown>, RegExp, { relayerFee?: string; nonce?: string }?]> = [
      [{ to: parseTronAddress("0x2000000000000000000000000000000000000009") }, /recipient/],
      [{ value: "2000000" }, /value/],
      [{ owner: parseTronAddress("0x2000000000000000000000000000000000000008") }, /owner/],
      [{ token: parseTronAddress("0x2000000000000000000000000000000000000007") }, /token/],
      [{ relayer: parseTronAddress("0x2000000000000000000000000000000000000006") }, /relayer binding/],
      [{ maxFee: "999000000" }, /maxFee/], // fee drain: shown 0.3, signed 999
      [{ nonce: "8" }, /nonce/],
      [{ deadline: String(Math.floor(Date.now() / 1000) + 86_400), maxFee: "300000" }, /deadline/],
    ];
    for (const [tamper, err, fees] of cases) {
      await expect(clientFor(quoteResponse(tamper, fees)).quote(request)).rejects.toThrow(err);
    }
  });

  it("enforces the caller's fee cap", async () => {
    await expect(clientFor(quoteResponse()).quote({ ...request, maxFee: 250_000n })).rejects.toThrow(/exceeds your maxFee/);
    const ok = await clientFor(quoteResponse()).quote({ ...request, maxFee: 300_000n });
    expect(ok.unsignedPermit.value).toBe(1_000_000n);
  });
});

describe("packed permit calldata", () => {
  it("is 197 bytes and bounds every narrowed field", async () => {
    const owner = privateKeyToAccount(keccak256(toHex("packed-owner")));
    const permit = buildPermit({
      token: "0x1000000000000000000000000000000000000002",
      owner: owner.address,
      to: "0x1000000000000000000000000000000000000003",
      value: 1_000_000n,
      maxFee: 300_000n,
      relayer: "0x1000000000000000000000000000000000000004",
      nonce: 7n,
    });
    const sig = { r: `0x${"11".repeat(32)}` as Hex, vs: `0x${"22".repeat(32)}` as Hex, v: 27, s: `0x${"22".repeat(32)}` as Hex, yParity: 0 };
    const data = encodePermitTransferPacked({ permit, signature: sig as never, relayerFee: 5n, feeRecipient: permit.relayer });
    expect((data.length - 2) / 2).toBe(197);
    // The ABI form stays available and is twice the size.
    const abiData = encodePermitTransfer({ permit, signature: sig as never, relayerFee: 5n, feeRecipient: permit.relayer });
    expect((abiData.length - 2) / 2).toBe(388);

    const big = { ...permit, value: 1n << 96n };
    expect(() => encodePermitTransferPacked({ permit: big as never, signature: sig as never, relayerFee: 5n, feeRecipient: permit.relayer })).toThrow();
  });
});

describe("EVM wallet signer (EIP-1193)", () => {
  it("a MetaMask-style eth_signTypedData_v4 signature recovers to the owner and matches the local-key digest", async () => {
    const key = keccak256(toHex("metamask-user"));
    const account = privateKeyToAccount(key);
    // Fake provider that signs exactly like MetaMask: EIP-712 hash of the v4 JSON payload.
    const requests: Array<{ method: string; params?: unknown[] }> = [];
    const provider = {
      async request(args: { method: string; params?: unknown[] }) {
        requests.push(args);
        if (args.method !== "eth_signTypedData_v4") throw new Error(`unexpected ${args.method}`);
        const [from, json] = args.params as [string, string];
        if (from.toLowerCase() !== account.address.toLowerCase()) throw new Error("wrong from");
        const td = JSON.parse(json);
        return account.signTypedData({ domain: { ...td.domain, chainId: Number(td.domain.chainId) }, types: td.types, primaryType: td.primaryType, message: td.message });
      },
    };
    const permit = buildPermit({
      token: "0x1000000000000000000000000000000000000002",
      owner: account.address,
      to: "0x1000000000000000000000000000000000000003",
      value: 1_000_000n,
      maxFee: 300_000n,
      relayer: "0x1000000000000000000000000000000000000004",
      nonce: 0n,
    });
    const ctx = { account: "0x1000000000000000000000000000000000000005", chainId: 3448148188 };
    const viaWallet = await signPermit(fromEip1193(provider, account.address), permit, ctx);
    const viaKey = await signPermit(fromPrivateKey(key), permit, ctx);
    // Same digest, same key: byte-identical signatures — the wallet path is
    // exactly the TIP-712 digest the contract verifies.
    expect(viaWallet.serialized).toBe(viaKey.serialized);
    // Preceded by the account check, which this stub does not answer.
    expect(requests.map((r) => r.method)).toEqual(["eth_accounts", "eth_signTypedData_v4"]);
  });

  it("rejects a wallet signing for the wrong account", async () => {
    const right = privateKeyToAccount(keccak256(toHex("right")));
    const wrong = privateKeyToAccount(keccak256(toHex("wrong")));
    const provider = {
      async request(args: { method: string; params?: unknown[] }) {
        const [, json] = args.params as [string, string];
        const td = JSON.parse(json);
        return wrong.signTypedData({ domain: { ...td.domain, chainId: Number(td.domain.chainId) }, types: td.types, primaryType: td.primaryType, message: td.message });
      },
    };
    const permit = buildPermit({
      token: "0x1000000000000000000000000000000000000002",
      owner: right.address,
      to: "0x1000000000000000000000000000000000000003",
      value: 1n,
      maxFee: 1n,
      relayer: ZERO_ADDRESS,
      nonce: 0n,
    });
    await expect(signPermit(fromEip1193(provider, right.address), permit, { account: "0x1000000000000000000000000000000000000005", chainId: 3448148188 })).rejects.toThrow(/does not recover/);
  });
});
