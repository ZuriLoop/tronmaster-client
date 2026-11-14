/**
 * The Turnkey path has to produce the same signature a local key would.
 *
 * It is not obvious that it does: `eip712` mode hands Turnkey the typed data
 * and trusts it to compute the digest our contract verifies, which means
 * trusting its EIP-712 implementation to agree with ours about field order,
 * the domain, and whether `EIP712Domain` belongs in `types`. If it disagrees
 * by one byte the signature recovers to nobody and the transfer fails.
 *
 * So both modes are checked against a locally signed permit, byte for byte.
 * The fake below signs the way Turnkey documents: it strips `EIP712Domain`
 * before hashing, and returns r/s/v unprefixed with v normalized to 0/1.
 */
import { hashTypedData } from "viem";
import { privateKeyToAccount, sign } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { parseTronAddress, toBase58 } from "../src/address.js";
import { buildPermit, getPermitDigest } from "../src/permit.js";
import { fromPrivateKey, signPermit } from "../src/sign.js";
import { type TurnkeySigningApi, turnkeyPermitSigner } from "../src/turnkey.js";

const KEY = `0x${"77".repeat(32)}` as const;
const OWNER = privateKeyToAccount(KEY).address;
const TOKEN = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const TO = "TBtLWd5sjSjrzZfmhYoyjxLAYgApx97gTv";
const RELAYER = "TXJM4bnA5dmWxzn2sZMQoBaAL6FcAyjVLa";
const CTX = { account: parseTronAddress("0x1000000000000000000000000000000000000005"), chainId: 3448148188 };

const permit = buildPermit({
  token: parseTronAddress(TOKEN),
  owner: parseTronAddress(OWNER),
  to: parseTronAddress(TO),
  value: 1_000_000n,
  maxFee: 1_000_000n,
  relayer: parseTronAddress(RELAYER),
  nonce: 0n,
  ttlSeconds: 180,
  now: Date.now(),
});

/** Records what it was asked to sign, so the request shape is assertable too. */
function fakeTurnkey() {
  const calls: Array<{ signWith: string; payload: string; encoding: string; hashFunction: string; organizationId?: string }> = [];
  const api: TurnkeySigningApi = {
    async signTransaction() {
      throw new Error("not used for permits");
    },
    async signRawPayload(input) {
      calls.push(input);
      let digest: `0x${string}`;
      if (input.encoding === "PAYLOAD_ENCODING_EIP712") {
        const td = JSON.parse(input.payload);
        // Turnkey hashes the typed data itself. EIP712Domain is carried in
        // `types` for wallets but is not a struct to hash over.
        const { EIP712Domain: _, ...types } = td.types;
        digest = hashTypedData({ domain: td.domain, types, primaryType: td.primaryType, message: td.message });
      } else {
        digest = input.payload as `0x${string}`;
      }
      const sig = (await sign({ hash: digest, privateKey: KEY, to: "hex" })).slice(2);
      return {
        r: sig.slice(0, 64),
        s: sig.slice(64, 128),
        // Turnkey returns the recovery id, not 27/28.
        v: (Number.parseInt(sig.slice(128), 16) - 27).toString(16).padStart(2, "0"),
      };
    },
  };
  return { api, calls };
}

describe("turnkeyPermitSigner", () => {
  it("eip712 mode matches a local key byte for byte", async () => {
    const { api } = fakeTurnkey();
    const viaTurnkey = await signPermit(turnkeyPermitSigner({ api, address: OWNER }), permit, CTX);
    const viaKey = await signPermit(fromPrivateKey(KEY), permit, CTX);
    expect(viaTurnkey.serialized).toBe(viaKey.serialized);
  });

  it("digest mode matches a local key byte for byte", async () => {
    const { api } = fakeTurnkey();
    const viaTurnkey = await signPermit(turnkeyPermitSigner({ api, address: OWNER, mode: "digest" }), permit, CTX);
    const viaKey = await signPermit(fromPrivateKey(KEY), permit, CTX);
    expect(viaTurnkey.serialized).toBe(viaKey.serialized);
  });

  it("sends the typed data for a policy to read, not an opaque hash", async () => {
    // The whole reason to prefer eip712: Turnkey can match on the permit's
    // fields. An opaque digest gives a policy nothing to pin.
    const { api, calls } = fakeTurnkey();
    await signPermit(turnkeyPermitSigner({ api, address: OWNER }), permit, CTX);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.encoding).toBe("PAYLOAD_ENCODING_EIP712");
    const td = JSON.parse(calls[0]!.payload);
    expect(td.primaryType).toBe("PermitTransfer");
    expect(td.message.token.toLowerCase()).toBe(parseTronAddress(TOKEN).toLowerCase());
    expect(td.message.to.toLowerCase()).toBe(parseTronAddress(TO).toLowerCase());
    expect(td.message.relayer.toLowerCase()).toBe(parseTronAddress(RELAYER).toLowerCase());
  });

  it("digest mode sends exactly the 32 bytes the contract verifies", async () => {
    const { api, calls } = fakeTurnkey();
    await signPermit(turnkeyPermitSigner({ api, address: OWNER, mode: "digest" }), permit, CTX);
    expect(calls[0]!.encoding).toBe("PAYLOAD_ENCODING_HEXADECIMAL");
    expect(calls[0]!.hashFunction).toBe("HASH_FUNCTION_NO_OP");
    expect(calls[0]!.payload).toBe(getPermitDigest(permit, CTX));
  });

  it("signs with the account's base58 address and the given sub-organization", async () => {
    // Sub-org is how an end user's own key is reached; getting it wrong signs
    // with the parent org's key, or nothing at all.
    const { api, calls } = fakeTurnkey();
    await signPermit(turnkeyPermitSigner({ api, address: OWNER, organizationId: "sub-org-1" }), permit, CTX);
    expect(calls[0]!.signWith).toBe(toBase58(OWNER));
    expect(calls[0]!.organizationId).toBe("sub-org-1");
  });

  it("rejects a signature from a different key rather than submitting it", async () => {
    // A Turnkey account that is not the permit's owner must fail here, on the
    // page, not as an on-chain revert the relayer has already paid for.
    const other = `0x${"22".repeat(32)}` as const;
    const api: TurnkeySigningApi = {
      async signTransaction() {
        throw new Error("not used");
      },
      async signRawPayload(input) {
        const td = JSON.parse(input.payload);
        const { EIP712Domain: _, ...types } = td.types;
        const sig = (await sign({ hash: hashTypedData({ domain: td.domain, types, primaryType: td.primaryType, message: td.message }), privateKey: other, to: "hex" })).slice(2);
        return { r: sig.slice(0, 64), s: sig.slice(64, 128), v: (Number.parseInt(sig.slice(128), 16) - 27).toString(16).padStart(2, "0") };
      },
    };
    await expect(signPermit(turnkeyPermitSigner({ api, address: OWNER }), permit, CTX)).rejects.toThrow(/does not recover/);
  });
});
