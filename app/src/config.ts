import { type TronChain, createPaymasterClient, parseTronAddress, tronMainnet, tronNile } from "@tron-paymaster/sdk";

/**
 * Build-time configuration. Everything has a working default for Nile so the
 * app runs with no setup; a deployment overrides them in `.env`.
 */
const env = import.meta.env;

const NETWORK = (env.VITE_TPM_NETWORK ?? "nile") as "nile" | "mainnet";
export const chain: TronChain = NETWORK === "mainnet" ? tronMainnet : tronNile;

const factoryOverride = env.VITE_TPM_FACTORY;
const deployed = chain.deployments[0]?.factory;
if (!factoryOverride && !deployed) {
  throw new Error(`no TronPaymaster factory known for ${chain.name}; set VITE_TPM_FACTORY`);
}
export const factory = parseTronAddress(factoryOverride ?? deployed!);

export const usdt = parseTronAddress(chain.usdt!);
export const USDT_DECIMALS = 6;
export const USDT_SYMBOL = NETWORK === "mainnet" ? "USDT" : "USDT (test)";

/**
 * Default relayer. Empty is valid: the UI then asks for one and explains that
 * relaying is permissionless, so anyone can run their own.
 */
export const defaultRelayer = env.VITE_TPM_RELAYER ?? "";

/**
 * Optional: a sponsorship policy that pays the relayer fee for this app's
 * users, with the API key that proves which project is asking. A relayer that
 * declines simply quotes the user as usual, so this never blocks a send.
 */
const sponsorshipPolicyId = env.VITE_TPM_SPONSORSHIP_POLICY || undefined;
const apiKey = env.VITE_TPM_API_KEY || undefined;

/**
 * Turnkey passkey wallet. Both values are public by design — they identify an
 * organization and its hosted auth proxy, and neither authorizes anything on
 * its own. Unset means the Turnkey option simply does not appear.
 *
 * `VITE_TURNKEY_SIGN_MODE=digest` makes Turnkey sign the permit digest as
 * opaque bytes instead of parsing the typed data. Only needed if Turnkey's
 * EIP-712 encoding ever disagrees with the contract's; the signature is
 * verified locally either way, so a mismatch fails before anything is sent.
 */
export const turnkey = env.VITE_TURNKEY_ORG_ID
  ? {
      organizationId: env.VITE_TURNKEY_ORG_ID as string,
      authProxyConfigId: env.VITE_TURNKEY_AUTH_PROXY_ID as string | undefined,
      signMode: (env.VITE_TURNKEY_SIGN_MODE === "digest" ? "digest" : "eip712") as "digest" | "eip712",
    }
  : undefined;

export const isTestnet = NETWORK !== "mainnet";
export const faucetUrl = "https://nileex.io/join/getJoinPage";
export const repoUrl = "https://github.com/ZuriLoop/tronmaster-client";

/** Read-only client; writes never happen from the browser. */
export const client = createPaymasterClient({ chain, factory });

/** Handed to <TronPaymasterProvider>; the hooks read everything from it. */
export const providerConfig = {
  chain,
  factory,
  token: usdt,
  decimals: USDT_DECIMALS,
  symbol: USDT_SYMBOL,
  relayerUrl: defaultRelayer || undefined,
  sponsorshipPolicyId,
  apiKey,
};

export const explorerTx = (txid: string) => `${chain.explorerUrl}/#/transaction/${txid}`;
export const explorerAddress = (address: string) => `${chain.explorerUrl}/#/address/${address}`;
