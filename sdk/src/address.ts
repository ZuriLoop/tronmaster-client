import { type Hex, sha256 } from "viem";

/**
 * A Tron address held as its 20-byte EVM form (`0x` + 40 lowercase hex).
 *
 * This is the form contracts and ABI encoding use. Convert at the edges with
 * {@link parseTronAddress} (accepts base58 `T…`, `41…` hex or `0x…` hex) and
 * {@link toBase58} / {@link toTronHex}.
 */
export type TronAddress = `0x${string}` & { readonly __brand: "TronAddress" };

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as TronAddress;

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ALPHABET_MAP: Record<string, number> = Object.fromEntries([...ALPHABET].map((c, i) => [c, i]));
const TRON_PREFIX = 0x41;

export class InvalidTronAddressError extends Error {
  constructor(input: string, reason: string) {
    super(`Invalid Tron address "${input}": ${reason}`);
    this.name = "InvalidTronAddressError";
  }
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

function checksum(payload: Uint8Array): Uint8Array {
  const once = hexToBytes(sha256(payload));
  return hexToBytes(sha256(once)).slice(0, 4);
}

export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  return "1".repeat(zeros) + out;
}

export function base58Decode(str: string): Uint8Array {
  let n = 0n;
  for (const c of str) {
    const v = ALPHABET_MAP[c];
    if (v === undefined) throw new Error(`invalid base58 character "${c}"`);
    n = n * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  let zeros = 0;
  while (zeros < str.length && str[zeros] === "1") zeros++;
  return new Uint8Array([...new Array(zeros).fill(0), ...bytes]);
}

const HEX40 = /^[0-9a-fA-F]{40}$/;

/**
 * Parses any common Tron address encoding and validates it.
 * - base58check `T…` (checksum and 0x41 prefix verified)
 * - `41…` hex (42 chars)
 * - `0x…` 20-byte hex
 */
export function parseTronAddress(input: string): TronAddress {
  if (typeof input !== "string") throw new InvalidTronAddressError(String(input), "not a string");
  const s = input.trim();
  if (s.startsWith("0x") || s.startsWith("0X")) {
    if (!HEX40.test(s.slice(2))) throw new InvalidTronAddressError(input, "expected 20-byte hex");
    return `0x${s.slice(2).toLowerCase()}` as TronAddress;
  }
  if (s.length === 42 && s.slice(0, 2) === "41") {
    if (!HEX40.test(s.slice(2))) throw new InvalidTronAddressError(input, "expected 41-prefixed hex");
    return `0x${s.slice(2).toLowerCase()}` as TronAddress;
  }
  if (s.length !== 34 || s[0] !== "T") throw new InvalidTronAddressError(input, "unrecognized format");
  let raw: Uint8Array;
  try {
    raw = base58Decode(s);
  } catch (e) {
    throw new InvalidTronAddressError(input, (e as Error).message);
  }
  if (raw.length !== 25) throw new InvalidTronAddressError(input, "wrong length");
  if (raw[0] !== TRON_PREFIX) throw new InvalidTronAddressError(input, "missing 0x41 prefix");
  const payload = raw.slice(0, 21);
  const sum = checksum(payload);
  for (let i = 0; i < 4; i++) {
    if (sum[i] !== raw[21 + i]) throw new InvalidTronAddressError(input, "bad checksum");
  }
  return `0x${bytesToHex(payload.slice(1))}` as TronAddress;
}

export function isTronAddress(input: unknown): boolean {
  try {
    parseTronAddress(input as string);
    return true;
  } catch {
    return false;
  }
}

/** Base58check `T…` form, as shown in wallets and Tronscan. */
export function toBase58(address: string): string {
  const hex = parseTronAddress(address);
  const payload = new Uint8Array([TRON_PREFIX, ...hexToBytes(hex)]);
  return base58Encode(new Uint8Array([...payload, ...checksum(payload)]));
}

/** `41…` hex form, as used by the java-tron HTTP API with `visible: false`. */
export function toTronHex(address: string): string {
  return `41${parseTronAddress(address).slice(2)}`;
}

/** 20-byte `0x` form (the canonical in-SDK representation). */
export function toHex(address: string): TronAddress {
  return parseTronAddress(address);
}

export function sameAddress(a: string, b: string): boolean {
  return parseTronAddress(a) === parseTronAddress(b);
}

/** @internal */
export const _bytes = { hexToBytes, bytesToHex };
export type { Hex };
