import { type TronAddress, parseTronAddress } from "./address.js";

export interface TronChain {
  /** TIP-712 chain id: `block.chainid & 0xffffffff`. */
  id: number;
  name: string;
  rpcUrl: string;
  explorerUrl?: string;
  /** Canonical USDT (TRC-20) on this network, if any. */
  usdt?: TronAddress;
  /** Known TronPaymaster deployments, newest first. */
  deployments: readonly Deployment[];
}

export interface Deployment {
  factory: TronAddress;
  forwarderRouter: TronAddress;
  accountRouter: TronAddress;
  /** Free-form label, e.g. "v1". */
  label?: string;
}

export const tronMainnet: TronChain = {
  id: 728126428,
  name: "mainnet",
  rpcUrl: "https://api.trongrid.io",
  explorerUrl: "https://tronscan.org",
  usdt: parseTronAddress("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"),
  deployments: [],
};

export const tronNile: TronChain = {
  id: 3448148188,
  name: "nile",
  rpcUrl: "https://nile.trongrid.io",
  explorerUrl: "https://nile.tronscan.org",
  usdt: parseTronAddress("TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf"),
  deployments: [
    {
      // Public test deployment, and the rehearsal for mainnet: the same
      // parameters that will be deployed there, with test roles — admin is a
      // single key, guardian a second one, so governance is actually
      // exercisable. 10 bps / 0.25 USDT under an immutable 30 bps / 1.00
      // ceiling, 7-day upgrade delay, 3-day maximum pause.
      //
      // Replaces nile-test-2026-11-10 (TSmQ19QbcLBr9PiYt4XiqePCFpn5jep6n4),
      // which predates the account's energy diet and has no
      // permitTransferPacked, and nile-test-2026-11-08
      // (TEZgEJXDosFmTPMUgHpT3bv1J1dXhGLqtp), which is pre-audit. Both abandoned.
      label: "nile-2026-11-14",
      factory: parseTronAddress("TXJM4bnA5dmWxzn2sZMQoBaAL6FcAyjVLa"),
      forwarderRouter: parseTronAddress("TFoC8LkN7VmxVk5SpWTsZNeSarHMxVLyVy"),
      accountRouter: parseTronAddress("TYas9bbMjoAsgEYgL7tJpbEBccCuyurx7t"),
    },
  ],
};

/** Local java-tron (e.g. the `tronbox/tre` image). Chain id is read at runtime. */
export function localChain(rpcUrl = "http://127.0.0.1:9090", id = 0): TronChain {
  return { id, name: "local", rpcUrl, deployments: [] };
}

export const chains = { mainnet: tronMainnet, nile: tronNile } as const;

/** Masks a raw `block.chainid` to its TIP-712 form. */
export function tip712ChainId(rawChainId: bigint | number): number {
  return Number(BigInt(rawChainId) & 0xffffffffn);
}
