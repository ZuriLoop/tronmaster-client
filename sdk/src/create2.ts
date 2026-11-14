import { type Hex, concat, encodeAbiParameters, keccak256, numberToHex, size, toBytes } from "viem";
import { type TronAddress, parseTronAddress } from "./address.js";

/** TVM CREATE2 prefix. EVM uses 0xff; this is the only difference in derivation. */
export const TRON_CREATE2_PREFIX: Hex = "0x41";
export const EVM_CREATE2_PREFIX: Hex = "0xff";

export interface Create2Params {
  deployer: string;
  salt: Hex;
  initCodeHash: Hex;
  /** Defaults to the TVM prefix `0x41`. `0xff` is only for EVM test harnesses. */
  prefix?: Hex;
}

export function computeCreate2Address({ deployer, salt, initCodeHash, prefix = TRON_CREATE2_PREFIX }: Create2Params): TronAddress {
  if (size(salt) !== 32) throw new Error("salt must be 32 bytes");
  if (size(initCodeHash) !== 32) throw new Error("initCodeHash must be 32 bytes");
  const h = keccak256(concat([prefix, parseTronAddress(deployer), salt, initCodeHash]));
  return `0x${h.slice(-40)}` as TronAddress;
}

/**
 * EIP-1167 clone init code with immutable args, byte-identical to
 * OpenZeppelin `Clones.cloneDeterministicWithImmutableArgs`.
 */
export function getCloneInitCode(implementation: string, args: Hex): Hex {
  const argsLen = size(args);
  if (argsLen > 0x5fd3) throw new Error("clone args too long");
  return concat([
    "0x61",
    numberToHex(argsLen + 0x2d, { size: 2 }),
    "0x3d81600a3d39f3363d3d373d3d3d363d73",
    parseTronAddress(implementation),
    "0x5af43d82803e903d91602b57fd5bf3",
    args,
  ]);
}

export interface ForwarderAddressParams {
  factory: string;
  /** The factory's immutable `FORWARDER_ROUTER`. */
  forwarderRouter: string;
  treasury: string;
  /** `address(0)` (default) makes sweeps permissionless. */
  sweeper?: string;
  salt: Hex;
  prefix?: Hex;
}

export function getForwarderArgs(treasury: string, sweeper?: string): Hex {
  return concat([parseTronAddress(treasury), parseTronAddress(sweeper ?? "0x0000000000000000000000000000000000000000")]);
}

export function getForwarderAddress(p: ForwarderAddressParams): TronAddress {
  const initCode = getCloneInitCode(p.forwarderRouter, getForwarderArgs(p.treasury, p.sweeper));
  return computeCreate2Address({ deployer: p.factory, salt: p.salt, initCodeHash: keccak256(initCode), prefix: p.prefix });
}

export interface AccountAddressParams {
  factory: string;
  /** The factory's immutable `ACCOUNT_ROUTER`. */
  accountRouter: string;
  owner: string;
  index?: bigint | number;
  prefix?: Hex;
}

export function getAccountSalt(owner: string, index: bigint | number = 0n): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [parseTronAddress(owner), BigInt(index)]));
}

export function getPermitAccountAddress(p: AccountAddressParams): TronAddress {
  const initCode = getCloneInitCode(p.accountRouter, parseTronAddress(p.owner));
  return computeCreate2Address({
    deployer: p.factory,
    salt: getAccountSalt(p.owner, p.index),
    initCodeHash: keccak256(initCode),
    prefix: p.prefix,
  });
}

const DEPOSIT_SALT_DOMAIN = "tron-paymaster/deposit-salt/v1:";

/**
 * Derives a per-deposit CREATE2 salt as HMAC-SHA256(secret, domain ‖ id).
 *
 * Lets a custodian derive any number of deposit addresses offline from one
 * secret and a stable id (user id, invoice id…) without storing salts, and
 * without the addresses being linkable by anyone who lacks the secret.
 */
export async function deriveDepositSalt(secret: Uint8Array | string, id: string): Promise<Hex> {
  if (!id) throw new Error("id is required");
  const keyBytes = typeof secret === "string" ? toBytes(secret) : secret;
  if (keyBytes.length < 16) throw new Error("secret must be at least 16 bytes");
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("WebCrypto (crypto.subtle) is not available in this runtime");
  const key = await subtle.importKey("raw", keyBytes as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await subtle.sign("HMAC", key, new TextEncoder().encode(DEPOSIT_SALT_DOMAIN + id));
  return `0x${[...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}
