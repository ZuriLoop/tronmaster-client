import { type Hex, hashTypedData } from "viem";
import { type TronAddress, ZERO_ADDRESS, parseTronAddress, toBase58 } from "./address.js";

declare const PERMIT_BRAND: unique symbol;
/** Permits created by this module. Copies (spread, JSON) are not members. */
const GENUINE = new WeakSet<object>();

/**
 * A signed-transfer instruction. Build with {@link buildPermit}; plain object
 * literals and wallet typed-data JSON are rejected by {@link getPermitDigest}.
 */
export interface Permit {
  readonly token: TronAddress;
  readonly owner: TronAddress;
  readonly to: TronAddress;
  /** Exact amount the recipient receives, in token base units. */
  readonly value: bigint;
  /** Upper bound on relayer fee + protocol fee, in token base units. */
  readonly maxFee: bigint;
  /** Fee credit is bound to this relayer. Zero address = any relayer. */
  readonly relayer: TronAddress;
  /** Unix seconds. */
  readonly deadline: bigint;
  readonly nonce: bigint;
  readonly [PERMIT_BRAND]: true;
}

export const PERMIT_DOMAIN_NAME = "TronPaymaster";
export const PERMIT_DOMAIN_VERSION = "1";

export const permitTypes = {
  PermitTransfer: [
    { name: "token", type: "address" },
    { name: "owner", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "maxFee", type: "uint256" },
    { name: "relayer", type: "address" },
    { name: "deadline", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

export const DEFAULT_PERMIT_TTL_SECONDS = 180;
export const WARN_PERMIT_TTL_SECONDS = 600;
export const MAX_PERMIT_TTL_SECONDS = 86_400;

export interface BuildPermitParams {
  token: string;
  owner: string;
  to: string;
  value: bigint | number | string;
  maxFee: bigint | number | string;
  nonce: bigint | number | string;
  /** Defaults to the zero address (any relayer). Prefer binding the quoting relayer. */
  relayer?: string;
  /** Absolute deadline (unix seconds). Overrides `ttlSeconds`. */
  deadline?: bigint | number;
  /** Lifetime from `now`. Default 180s. */
  ttlSeconds?: number;
  /** Unix seconds; defaults to the local clock. Pass chain time where it matters. */
  now?: number;
  /** Required for lifetimes above 24h. */
  allowLongDeadline?: boolean;
  onWarning?: (message: string) => void;
}

const UINT256_MAX = 2n ** 256n - 1n;

function makePermit(f: {
  token: string;
  owner: string;
  to: string;
  value: bigint | number | string;
  maxFee: bigint | number | string;
  relayer?: string;
  deadline: bigint | number | string;
  nonce: bigint | number | string;
}): Permit {
  const value = BigInt(f.value);
  const maxFee = BigInt(f.maxFee);
  const nonce = BigInt(f.nonce);
  const deadline = BigInt(f.deadline);
  if (value <= 0n) throw new Error("value must be positive");
  for (const [k, x] of [["value", value], ["maxFee", maxFee], ["nonce", nonce], ["deadline", deadline]] as const) {
    if (x < 0n || x > UINT256_MAX) throw new Error(`${k} out of uint256 range`);
  }
  const permit = {
    token: parseTronAddress(f.token),
    owner: parseTronAddress(f.owner),
    to: parseTronAddress(f.to),
    value,
    maxFee,
    relayer: f.relayer ? parseTronAddress(f.relayer) : ZERO_ADDRESS,
    deadline,
    nonce,
  };
  if (permit.to === ZERO_ADDRESS) throw new Error("recipient cannot be the zero address");
  Object.freeze(permit);
  GENUINE.add(permit);
  return permit as unknown as Permit;
}

/** Builds a permit, applying the deadline policy (default 180s, warn >10min, refuse >24h). */
export function buildPermit(p: BuildPermitParams): Permit {
  const now = p.now ?? Math.floor(Date.now() / 1000);
  const deadline = p.deadline !== undefined ? BigInt(p.deadline) : BigInt(now + (p.ttlSeconds ?? DEFAULT_PERMIT_TTL_SECONDS));
  const ttl = deadline - BigInt(now);
  if (ttl <= 0n) throw new Error("permit deadline is in the past");
  if (ttl > BigInt(MAX_PERMIT_TTL_SECONDS) && !p.allowLongDeadline) {
    throw new Error(`permit lifetime ${ttl}s exceeds 24h; pass allowLongDeadline to override`);
  }
  if (ttl > BigInt(WARN_PERMIT_TTL_SECONDS)) {
    (p.onWarning ?? console.warn)(`permit lifetime ${ttl}s is long; short deadlines limit phishing exposure`);
  }
  return makePermit({ ...p, deadline });
}

export function isPermit(x: unknown): x is Permit {
  return typeof x === "object" && x !== null && GENUINE.has(x);
}

export function assertPermit(x: unknown): asserts x is Permit {
  if (!isPermit(x)) {
    throw new TypeError(
      "expected a Permit from buildPermit(); wallet typed-data JSON and plain objects are not accepted (they can carry base58 addresses that hash differently)",
    );
  }
}

export interface PermitContext {
  /** The PermitAccount (TIP-712 verifyingContract). */
  account: string;
  /** TIP-712 chain id (`block.chainid & 0xffffffff`). */
  chainId: number;
}

export function getPermitDomain({ account, chainId }: PermitContext) {
  return {
    name: PERMIT_DOMAIN_NAME,
    version: PERMIT_DOMAIN_VERSION,
    chainId,
    verifyingContract: parseTronAddress(account),
  } as const;
}

function message(p: Permit) {
  return {
    token: p.token,
    owner: p.owner,
    to: p.to,
    value: p.value,
    maxFee: p.maxFee,
    relayer: p.relayer,
    deadline: p.deadline,
    nonce: p.nonce,
  };
}

/** The 32-byte TIP-712 digest the contract verifies. */
export function getPermitDigest(permit: Permit, ctx: PermitContext): Hex {
  assertPermit(permit);
  return hashTypedData({
    domain: getPermitDomain(ctx),
    types: permitTypes,
    primaryType: "PermitTransfer",
    message: message(permit),
  });
}

export type AddressFormat = "hex" | "base58";

/**
 * Typed data for wallet `signTypedData` calls. Some Tron wallets expect
 * base58 addresses; the resulting digest is identical either way only if the
 * wallet converts them back — always check the signature with
 * `verifyPermitSignature` before submitting.
 */
export function getPermitTypedData(permit: Permit, ctx: PermitContext, opts: { addressFormat?: AddressFormat } = {}) {
  assertPermit(permit);
  const fmt = (a: TronAddress) => (opts.addressFormat === "base58" ? toBase58(a) : a);
  const m = message(permit);
  return {
    domain: { ...getPermitDomain(ctx), verifyingContract: fmt(parseTronAddress(ctx.account)) },
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      ...permitTypes,
    },
    primaryType: "PermitTransfer" as const,
    message: {
      ...m,
      token: fmt(m.token),
      owner: fmt(m.owner),
      to: fmt(m.to),
      relayer: fmt(m.relayer),
      value: m.value.toString(),
      maxFee: m.maxFee.toString(),
      deadline: m.deadline.toString(),
      nonce: m.nonce.toString(),
    },
  };
}

/** JSON-safe form for transport (bigints as decimal strings). */
export function serializePermit(p: Permit) {
  assertPermit(p);
  return {
    token: p.token,
    owner: p.owner,
    to: p.to,
    value: p.value.toString(),
    maxFee: p.maxFee.toString(),
    relayer: p.relayer,
    deadline: p.deadline.toString(),
    nonce: p.nonce.toString(),
  };
}
export type SerializedPermit = ReturnType<typeof serializePermit>;

/**
 * Rebuilds a Permit from {@link serializePermit} output. Validates every field
 * but applies no deadline policy (that is the signer's concern, and the
 * contract enforces expiry).
 */
export function deserializePermit(s: SerializedPermit): Permit {
  return makePermit(s);
}
