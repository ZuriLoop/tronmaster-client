import { type Hex, type LocalAccount, hexToBigInt, isHex, numberToHex, recoverAddress, size } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { type TronAddress, parseTronAddress, sameAddress } from "./address.js";
import { type Permit, type PermitContext, getPermitDigest, getPermitTypedData } from "./permit.js";

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const HALF_N = SECP256K1_N / 2n;

/** A signature in the contract's 64-byte form plus its 65-byte equivalent. */
export interface PermitSignature {
  r: Hex;
  /** `s` with the y-parity in the top bit (EIP-2098). */
  vs: Hex;
  v: 27 | 28;
  s: Hex;
  /** r ‖ s ‖ v (65 bytes). */
  serialized: Hex;
}

/** Anything that can sign a permit for a Tron owner key. */
export interface PermitSigner {
  readonly address: TronAddress;
  /** Raw digest signer (custodial KMS / HSM / MPC). Preferred when available. */
  signDigest?(digest: Hex): Promise<Hex | { r: Hex; s: Hex; v: number | bigint }>;
  /** Wallet typed-data signer. Used when `signDigest` is absent. */
  signTypedData?(typedData: ReturnType<typeof getPermitTypedData>): Promise<Hex>;
}

/** Wraps a viem local account (private key, mnemonic, HD). */
export function fromViemAccount(account: LocalAccount): PermitSigner {
  return {
    address: parseTronAddress(account.address),
    signDigest: account.sign ? (digest) => account.sign!({ hash: digest }) : undefined,
    signTypedData: (td) =>
      account.signTypedData({
        domain: td.domain as never,
        types: { PermitTransfer: td.types.PermitTransfer },
        primaryType: "PermitTransfer",
        message: td.message as never,
      }),
  };
}

export function fromPrivateKey(privateKey: Hex): PermitSigner {
  return fromViemAccount(privateKeyToAccount(privateKey));
}

/** For custodial signers that sign a 32-byte digest (KMS, HSM, MPC). */
export function fromDigestSigner(params: {
  address: string;
  sign: (digest: Hex) => Promise<Hex | { r: Hex; s: Hex; v: number | bigint }>;
}): PermitSigner {
  return { address: parseTronAddress(params.address), signDigest: params.sign };
}

/**
 * For browser wallets exposing TronWeb (`window.tronWeb`). Uses
 * `trx._signTypedData(domain, types, message)` with hex addresses.
 */
export function fromInjectedTron(tronWeb: {
  defaultAddress: { base58: string };
  trx: { _signTypedData(domain: unknown, types: unknown, message: unknown): Promise<string> };
}): PermitSigner {
  return {
    address: parseTronAddress(tronWeb.defaultAddress.base58),
    signTypedData: async (td) => {
      const sig = await tronWeb.trx._signTypedData(td.domain, { PermitTransfer: td.types.PermitTransfer }, td.message);
      return (sig.startsWith("0x") ? sig : `0x${sig}`) as Hex;
    },
  };
}

/** The subset of EIP-1193 these adapters need (MetaMask, Rabby, any injected EVM wallet). */
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

/** Minimal network description for `wallet_addEthereumChain`. */
export interface EvmNetwork {
  /** TIP-712 chain id (mainnet 728126428, Nile 3448148188). */
  chainId: number;
  chainName: string;
  rpcUrls: string[];
  blockExplorerUrls?: string[];
}

/** Tron networks as an EVM wallet must see them (TronGrid speaks eth_* JSON-RPC). */
export const TRON_EVM_NETWORKS: Record<string, EvmNetwork> = {
  mainnet: {
    chainId: 728126428,
    chainName: "Tron",
    rpcUrls: ["https://api.trongrid.io/jsonrpc"],
    blockExplorerUrls: ["https://tronscan.org"],
  },
  nile: {
    chainId: 3448148188,
    chainName: "Tron Nile testnet",
    rpcUrls: ["https://nile.trongrid.io/jsonrpc"],
    blockExplorerUrls: ["https://nile.tronscan.org"],
  },
};

/**
 * Points an EVM wallet at a Tron network, adding it if unknown.
 *
 * Required before signing: MetaMask validates `domain.chainId` against the
 * wallet's active chain and rejects a mismatch outright
 * ("Provided chainId ... must match the active chainId"), before any prompt.
 * TronGrid exposes an Ethereum-compatible JSON-RPC whose `eth_chainId` equals
 * the TIP-712 chain id, so Tron can be added as an ordinary custom network.
 */
export async function ensureTronNetwork(provider: Eip1193Provider, network: EvmNetwork): Promise<void> {
  const hex = `0x${network.chainId.toString(16)}`;
  const current = await provider.request({ method: "eth_chainId" }).catch(() => undefined);
  if (typeof current === "string" && Number.parseInt(current, 16) === network.chainId) return;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (e) {
    // Anything but an outright rejection is worth one attempt at adding the
    // chain, because adding is how a wallet is *asked*. 4902 (unknown chain)
    // is the documented case; MetaMask's permission model also answers 4100
    // ("not been authorized by the user") for a chain the site was never
    // granted, and that one is indistinguishable from a hard failure by code
    // alone. wallet_addEthereumChain prompts for both adding and switching,
    // is idempotent for a chain already present, and cannot do anything the
    // user does not confirm — so trying it is strictly better than guessing
    // which codes deserve it.
    const code = (e as { code?: number }).code;
    if (code === 4001) throw e; // the user said no; asking again is nagging
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: hex,
          chainName: network.chainName,
          rpcUrls: network.rpcUrls,
          // 18, although TRX has 6: MetaMask hard-rejects any other value
          // ("Expected the number 18 for 'nativeCurrency.decimals'"), so 6
          // fails to add the chain at all and no permit can be signed. The
          // only cost is that the wallet would misread a native TRX balance
          // on this network — and an account here never holds TRX, which is
          // the entire point of it.
          nativeCurrency: { name: "TRX", symbol: "TRX", decimals: 18 },
          ...(network.blockExplorerUrls ? { blockExplorerUrls: network.blockExplorerUrls } : {}),
        },
      ],
    });
    // Adding usually switches too, but it is not promised. One more switch
    // costs nothing when the wallet already moved, and saves the confusing
    // "chainId must match the active chainId" at signing time when it did not.
    const after = await provider.request({ method: "eth_chainId" }).catch(() => undefined);
    if (typeof after === "string" && Number.parseInt(after, 16) === network.chainId) return;
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  }
}

/**
 * Makes sure the wallet will sign for this exact account before asking it to.
 *
 * A wallet signs only for accounts the site holds permission on, and that set
 * is not the same thing as the account the wallet is *showing*: switching
 * accounts in the extension, revoking a site, or connecting a second account
 * all move it. Signing for an account outside it fails with 4100 — the same
 * "not been authorized by the user" the user would see for a chain, with no
 * hint that an account is what it means.
 *
 * `eth_accounts` reports the permitted set without prompting. If the account
 * is missing, `eth_requestAccounts` asks for it, which is the prompt the user
 * needs rather than an error they cannot act on.
 */
async function ensureAuthorized(provider: Eip1193Provider, from: string): Promise<void> {
  const ask = (method: string) => provider.request({ method }).catch(() => undefined);
  const has = (list: unknown[]) => list.some((a) => typeof a === "string" && a.toLowerCase() === from);
  // A provider that does not report its accounts is not evidence of anything,
  // and a check is no place to refuse work the wallet might well do: only a
  // list that exists and leaves this account out is worth stopping for.
  const listed = await ask("eth_accounts");
  if (!Array.isArray(listed) || has(listed)) return;
  const granted = await ask("eth_requestAccounts");
  if (!Array.isArray(granted) || has(granted)) return;
  throw new Error(`this wallet has not connected ${from} to this site — open it, connect that account, and try again`);
}

/**
 * Signs permits with an EVM browser wallet (MetaMask, Rabby, Coinbase Wallet —
 * anything speaking EIP-1193). Tron and Ethereum share the secp256k1 curve, so
 * an EVM account's key IS a valid Tron owner key, and a TIP-712 permit IS
 * EIP-712 typed data. The wallet never sees or builds a Tron transaction — it
 * only signs typed data that any relayer executes on Tron.
 *
 * It does need to *recognize* the network, though: MetaMask refuses to sign
 * typed data whose `domain.chainId` differs from the active chain. Pass
 * `network` (see {@link TRON_EVM_NETWORKS}) and the signer will add/switch to
 * it before signing; omit it only if the caller handles that itself.
 *
 * `account` is the wallet's 0x address (from `eth_requestAccounts`); the same
 * 20 bytes are the owner's Tron address.
 */
export function fromEip1193(provider: Eip1193Provider, account: string, network?: EvmNetwork): PermitSigner {
  const address = parseTronAddress(account);
  return {
    address,
    signTypedData: async (td) => {
      const from = `0x${address.slice(2)}`;
      if (network) await ensureTronNetwork(provider, network);
      await ensureAuthorized(provider, from);
      // v4 wants the JSON payload; getPermitTypedData is already JSON-safe
      // (bigints as decimal strings) and already carries EIP712Domain.
      const ask = () => provider.request({ method: "eth_signTypedData_v4", params: [from, JSON.stringify(td)] });
      const sig = await ask().catch(async (e: unknown) => {
        if (/must match the active chainId/i.test((e as Error)?.message ?? "")) {
          throw new Error(
            `the wallet is on a different network than this permit — switch it to ${network?.chainName ?? "the Tron network"} and try again`,
          );
        }
        if ((e as { code?: number })?.code !== 4100) throw e;
        // 4100 with the account already permitted means the permission does
        // not reach this chain: MetaMask scopes it per chain, and a network
        // added while the site was connected lands outside the scope granted
        // at connect time. eth_accounts keeps listing the account, so nothing
        // visible says so. Re-requesting the permission from the new chain is
        // what widens the scope, and it is a prompt the user can answer.
        await provider.request({ method: "wallet_requestPermissions", params: [{ eth_accounts: {} }] }).catch(() => undefined);
        return await ask().catch((e2: unknown) => {
          throw new Error(
            `the wallet will not sign for ${from} on ${network?.chainName ?? "this network"} (code ${(e2 as { code?: number })?.code ?? "?"}) — open it, connect this site while that network is selected, and try again`,
          );
        });
      });
      if (typeof sig !== "string") throw new Error("wallet returned a non-string signature");
      return (sig.startsWith("0x") ? sig : `0x${sig}`) as Hex;
    },
  };
}

/**
 * Normalizes any secp256k1 signature to the form the contract accepts:
 * v ∈ {27, 28}, low-s only (high-s is rejected, not flipped, since a signer
 * producing it is misbehaving).
 */
export function normalizeSignature(sig: Hex | { r: Hex; s: Hex; v: number | bigint }): PermitSignature {
  let r: Hex;
  let s: Hex;
  let v: number;
  if (typeof sig === "string") {
    if (!isHex(sig) || size(sig) !== 65) throw new Error("expected a 65-byte signature");
    r = `0x${sig.slice(2, 66)}`;
    s = `0x${sig.slice(66, 130)}`;
    v = Number.parseInt(sig.slice(130, 132), 16);
  } else {
    r = numberToHex(hexToBigInt(sig.r), { size: 32 });
    s = numberToHex(hexToBigInt(sig.s), { size: 32 });
    v = Number(sig.v);
  }
  if (v === 0 || v === 1) v += 27;
  if (v !== 27 && v !== 28) throw new Error(`invalid recovery id v=${v}`);
  const sNum = hexToBigInt(s);
  if (sNum === 0n || sNum > HALF_N) throw new Error("signature s is not in the lower half order (malleable)");
  if (hexToBigInt(r) === 0n) throw new Error("signature r is zero");
  const vs = numberToHex(sNum | (BigInt(v - 27) << 255n), { size: 32 });
  return { r, s, v: v as 27 | 28, vs, serialized: `0x${r.slice(2)}${s.slice(2)}${v.toString(16)}` };
}

/** Recovers the signer of a permit and checks it against `expected`. */
export async function verifyPermitSignature(
  permit: Permit,
  ctx: PermitContext,
  signature: PermitSignature,
  expected: string = permit.owner,
): Promise<boolean> {
  const recovered = await recoverAddress({ hash: getPermitDigest(permit, ctx), signature: signature.serialized });
  return sameAddress(recovered, expected);
}

export interface SignPermitOptions {
  /** Address that must recover from the signature. Defaults to the permit owner
   * (pass the account's rotated `signer()` when one is set). */
  expectedSigner?: string;
}

/**
 * Signs a permit and verifies locally that it recovers to the expected signer
 * before returning — a bad wallet encoding fails here, not on-chain.
 */
export async function signPermit(
  signer: PermitSigner,
  permit: Permit,
  ctx: PermitContext,
  opts: SignPermitOptions = {},
): Promise<PermitSignature> {
  let raw: Hex | { r: Hex; s: Hex; v: number | bigint };
  if (signer.signDigest) raw = await signer.signDigest(getPermitDigest(permit, ctx));
  else if (signer.signTypedData) raw = await signer.signTypedData(getPermitTypedData(permit, ctx));
  else throw new Error("signer supports neither signDigest nor signTypedData");
  const sig = normalizeSignature(raw);
  const expected = opts.expectedSigner ?? permit.owner;
  if (!(await verifyPermitSignature(permit, ctx, sig, expected))) {
    throw new Error("signature does not recover to the expected signer (wrong key, chain id, account or encoding)");
  }
  return sig;
}
