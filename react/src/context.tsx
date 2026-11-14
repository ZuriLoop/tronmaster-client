import {
  type PaymasterClient,
  type TronAddress,
  type TronChain,
  createPaymasterClient,
  parseTronAddress,
  tronMainnet,
  tronNile,
} from "@tron-paymaster/sdk";
import { type ReactNode, createContext, useContext, useMemo } from "react";

/**
 * Configuration every hook needs. Supplied once at the top of an app so the
 * hooks stay free of module-level globals and a host can run more than one
 * configuration (for example a testnet preview beside production).
 */
export interface TronPaymasterConfig {
  /** `"mainnet"`, `"nile"`, or a full chain object. */
  chain: TronChain | "mainnet" | "nile";
  /**
   * Factory address. Defaults to the chain's published deployment.
   *
   * Treat this as build-time constant: an account address commits to its
   * factory, so an address derived against one factory has no code — and can
   * never have code — under another. Switching it at runtime can send a user
   * to an address nobody is able to deploy.
   */
  factory?: string;
  /** Token the hooks operate on. Defaults to the chain's USDT. */
  token?: string;
  decimals?: number;
  symbol?: string;
  /** Default relayer URL(s). Relaying is permissionless; several give failover. */
  relayerUrl?: string | string[];
  apiKey?: string;
  /**
   * Ask this sponsorship policy to pay the relayer fee instead of the user.
   * A relayer that declines still returns an ordinary priced quote, so the
   * send flow continues with the user paying — never fails because of this.
   */
  sponsorshipPolicyId?: string;
}

export interface TronPaymasterContextValue {
  chain: TronChain;
  client: PaymasterClient;
  factory: TronAddress;
  token: TronAddress;
  decimals: number;
  symbol: string;
  relayerUrl?: string | string[];
  apiKey?: string;
  sponsorshipPolicyId?: string;
}

const Ctx = createContext<TronPaymasterContextValue | undefined>(undefined);

const resolveChain = (c: TronPaymasterConfig["chain"]): TronChain =>
  c === "mainnet" ? tronMainnet : c === "nile" ? tronNile : c;

export function TronPaymasterProvider({ config, children }: { config: TronPaymasterConfig; children: ReactNode }) {
  const value = useMemo<TronPaymasterContextValue>(() => {
    const chain = resolveChain(config.chain);
    const factoryAddr = config.factory ?? chain.deployments[0]?.factory;
    if (!factoryAddr) throw new Error(`no TronPaymaster factory known for ${chain.name}; pass config.factory`);
    const tokenAddr = config.token ?? chain.usdt;
    if (!tokenAddr) throw new Error(`no default token for ${chain.name}; pass config.token`);
    return {
      chain,
      factory: parseTronAddress(factoryAddr),
      token: parseTronAddress(tokenAddr),
      decimals: config.decimals ?? 6,
      symbol: config.symbol ?? "USDT",
      relayerUrl: config.relayerUrl,
      apiKey: config.apiKey,
      sponsorshipPolicyId: config.sponsorshipPolicyId,
      // Read-only: a browser never holds a key that pays Tron fees.
      client: createPaymasterClient({ chain, factory: factoryAddr, apiKey: config.apiKey }),
    };
  }, [config]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTronPaymaster(): TronPaymasterContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("wrap your app in <TronPaymasterProvider config={…}>");
  return v;
}
