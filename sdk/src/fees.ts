import { sameAddress } from "./address.js";

export const BPS_DENOMINATOR = 10_000n;

export interface ProtocolFeeConfig {
  feeToken: string;
  bps: number | bigint;
  cap: bigint;
}

/** Mirrors `PaymasterFactory.protocolFee`: min(value·bps/10⁴ rounded down, cap), fee token only. */
export function computeProtocolFee(cfg: ProtocolFeeConfig, token: string, value: bigint): bigint {
  if (/^0x0{40}$/i.test(cfg.feeToken) || !sameAddress(cfg.feeToken, token)) return 0n;
  const bps = BigInt(cfg.bps);
  if (bps === 0n || cfg.cap === 0n) return 0n;
  const fee = (value * bps) / BPS_DENOMINATOR;
  return fee < cfg.cap ? fee : cfg.cap;
}

/**
 * `maxFee` to sign: relayer fee + protocol fee, plus an optional buffer that
 * absorbs a protocol-fee change between quote and execution.
 */
export function suggestMaxFee(params: { relayerFee: bigint; protocolFee: bigint; bufferBps?: number }): bigint {
  const base = params.relayerFee + params.protocolFee;
  const buffer = (base * BigInt(params.bufferBps ?? 0)) / BPS_DENOMINATOR;
  return base + buffer;
}

/** Parses a decimal amount ("1.5") to base units. Rejects excess precision. */
export function parseUnits(amount: string, decimals: number): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (!m) throw new Error(`invalid amount "${amount}"`);
  const frac = m[2] ?? "";
  if (frac.length > decimals) throw new Error(`amount "${amount}" has more than ${decimals} decimals`);
  return BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

export function formatUnits(value: bigint, decimals: number): string {
  const neg = value < 0n;
  const v = neg ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}
