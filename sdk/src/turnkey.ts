/**
 * Turnkey signer adapters.
 *
 * - `turnkeyTronSigner`: pays energy and signs Tron transactions through
 *   `signTransaction` with `TRANSACTION_TYPE_TRON`. Turnkey parses the
 *   transaction, so policies can pin the contract, selector and arguments
 *   (see policies.ts).
 * - `turnkeyPermitSigner`: signs TronPaymaster permits as EIP-712 typed data
 *   (`PAYLOAD_ENCODING_EIP712`). TIP-712 is EIP-712 with the chain id masked to
 *   4 bytes, so Turnkey computes the exact digest the contract verifies, and
 *   policies can constrain the permit's fields (`eth.eip_712.*`).
 *
 * Both depend only on the two Turnkey API methods below — the interface is
 * structural, so this module adds no dependency — and work with
 * `@turnkey/sdk-server` (`turnkey.apiClient()`), `@turnkey/sdk-browser`, or
 * anything else exposing the same calls.
 *
 * Why this lives in the SDK: it is a signer adapter, like `fromInjectedTron`
 * and `fromEip1193` in sign.ts. A relayer that signs through Turnkey holds no
 * private key on its host, which is the difference between a key you rotate
 * and a key you re-provision.
 */
import type { Hex } from "viem";
import { type TronAddress, parseTronAddress, toBase58 } from "./address.js";
import type { Permit, getPermitTypedData } from "./permit.js";
import type { PermitSigner } from "./sign.js";
import type { TronSigner, TronTransaction } from "./tron.js";

export interface TurnkeySigningApi {
  signTransaction(input: {
    signWith: string;
    unsignedTransaction: string;
    type: "TRANSACTION_TYPE_TRON";
    organizationId?: string;
  }): Promise<{ signedTransaction: string }>;
  signRawPayload(input: {
    signWith: string;
    payload: string;
    encoding: "PAYLOAD_ENCODING_EIP712" | "PAYLOAD_ENCODING_HEXADECIMAL";
    hashFunction: "HASH_FUNCTION_NO_OP";
    organizationId?: string;
  }): Promise<{ r: string; s: string; v: string }>;
}

export interface TurnkeySignerOptions {
  api: TurnkeySigningApi;
  /** The Turnkey wallet account's Tron address (base58 or hex). */
  address: string;
  /** Sub-organization id, when signing for an end user's sub-org. */
  organizationId?: string;
}

/**
 * Tron transaction signer backed by Turnkey. The SDK verifies the returned
 * signed transaction (raw_data unchanged, signature recovers to `address`)
 * before broadcasting.
 */
export function turnkeyTronSigner(o: TurnkeySignerOptions): TronSigner {
  const signWith = toBase58(o.address);
  return {
    address: parseTronAddress(o.address) as TronAddress,
    async signRawTransaction(tx: TronTransaction) {
      const { signedTransaction } = await o.api.signTransaction({
        signWith,
        unsignedTransaction: tx.raw_data_hex,
        type: "TRANSACTION_TYPE_TRON",
        organizationId: o.organizationId,
      });
      return signedTransaction;
    },
  };
}

/**
 * Permit signer backed by Turnkey EIP-712 signing. The SDK checks the
 * signature recovers to the account's signer before it is ever submitted.
 */
export function turnkeyPermitSigner(o: TurnkeySignerOptions): PermitSigner {
  const signWith = toBase58(o.address);
  return {
    address: parseTronAddress(o.address) as TronAddress,
    async signTypedData(typedData: ReturnType<typeof getPermitTypedData>) {
      const { r, s, v } = await o.api.signRawPayload({
        signWith,
        payload: JSON.stringify(typedData),
        encoding: "PAYLOAD_ENCODING_EIP712",
        hashFunction: "HASH_FUNCTION_NO_OP",
        organizationId: o.organizationId,
      });
      // Pad defensively: ~1 in 128 signatures has a short r or s, and the
      // 65-byte concatenation must stay aligned. (The SDK still verifies
      // recovery before anything is submitted.)
      const word = (x: string) => x.replace(/^0x/, "").padStart(64, "0");
      const vByte = (x: string) => x.replace(/^0x/, "").padStart(2, "0");
      return `0x${word(r)}${word(s)}${vByte(v)}` as Hex;
    },
  };
}

/** Human-readable summary of what a permit authorizes (show it before signing). */
export function describePermit(p: Permit, decimals = 6, symbol = "USDT"): string {
  const fmt = (x: bigint) => `${Number(x) / 10 ** decimals} ${symbol}`;
  return [
    `send ${fmt(p.value)} to ${toBase58(p.to)}`,
    `max fee ${fmt(p.maxFee)} (relayer ${/^0x0{40}$/.test(p.relayer) ? "any" : toBase58(p.relayer)})`,
    `valid until ${new Date(Number(p.deadline) * 1000).toISOString()}, nonce ${p.nonce}`,
  ].join("\n");
}
