/**
 * A wallet with no extension and no seed phrase.
 *
 * Turnkey holds the key; a passkey authorises its use. The key is still an
 * ordinary secp256k1 key, so the gasless address derives from it exactly as it
 * would from MetaMask — and the permit it signs is the same TIP-712 typed data
 * the contract verifies. Nothing downstream knows the difference: this
 * produces a `Connection`, and `SendPanel` passes its signer to `useTransfer`
 * without ever asking which kind of wallet it came from.
 *
 * It also sidesteps the entire class of problems an EVM extension brings —
 * there is no chain to add, no chain to switch to, and no per-chain
 * permission to be missing — because nothing here is pretending to be an
 * Ethereum wallet.
 */
import { type Connection, registerWallet } from "@tron-paymaster/react";
import { type TurnkeySigningApi, parseTronAddress, turnkeyPermitSigner } from "@tron-paymaster/sdk";
import { TurnkeyProvider, useTurnkey } from "@turnkey/react-wallet-kit";
import { useEffect, useRef } from "react";
import { turnkey } from "./config.js";
import "@turnkey/react-wallet-kit/styles.css";

const WALLET_ID = "turnkey-passkey";
const TRON_ACCOUNT = { curve: "CURVE_SECP256K1", pathFormat: "PATH_FORMAT_BIP32", path: "m/44'/195'/0'", addressFormat: "ADDRESS_FORMAT_TRON" } as const;

/**
 * Loaded only when Turnkey is configured — see `turnkey.tsx`. It renders no
 * children: the provider exists for the bridge below and for Turnkey's own
 * modal, which portals into the body, so the app does not sit inside it and
 * does not wait for this chunk to arrive.
 */
export default function TurnkeyShell() {
  if (!turnkey) return null;
  return (
    <TurnkeyProvider
      config={{
        organizationId: turnkey.organizationId,
        ...(turnkey.authProxyConfigId ? { authProxyConfigId: turnkey.authProxyConfigId } : {}),
      }}
    >
      <TurnkeyBridge />
    </TurnkeyProvider>
  );
}

/**
 * Registers the wallet. Renders nothing: Turnkey's own modal is the entire
 * sign-in UI, so there is no screen of ours to keep in step with it.
 */
function TurnkeyBridge() {
  const tk = useTurnkey();
  // Read through a ref, and register exactly once. The context value is a new
  // object on most renders, so an effect keyed on it would unregister and
  // re-register continuously — and `useWallet` polls `detectWallets()` on a
  // timer, so the wallet would flicker in and out of the list it is supposed
  // to be sitting in.
  const latest = useRef(tk);
  latest.current = tk;

  useEffect(() => {
    const cfg = turnkey;
    if (!cfg) return;
    return registerWallet({
      kind: "embedded",
      id: WALLET_ID,
      name: "Passkey",
      async connect(): Promise<Connection> {
        // Opens Turnkey's modal when there is no session. On a returning
        // visitor the session is already there and nothing is shown.
        const t = latest.current;
        if (!t.session) await t.handleLogin();

        const organizationId = t.session?.organizationId;
        const address = await tronAddress(t);
        if (!address) throw new Error("Turnkey did not return a Tron account for this wallet");

        return {
          kind: "embedded",
          id: WALLET_ID,
          name: "Passkey",
          owner: parseTronAddress(address),
          signer: turnkeyPermitSigner({
            api: t.httpClient as unknown as TurnkeySigningApi,
            address,
            organizationId,
            mode: cfg.signMode,
          }),
          // Turnkey can sign Tron transactions, but this app never asks it to
          // — the owner-exit path is a separate tool, not a browser flow.
          canSignTronTx: false,
        };
      },
    });
  }, []);

  return null;
}

/**
 * The account to sign with, creating it if the organization's default wallet
 * does not include one.
 *
 * It must be the Tron-derived account specifically: Turnkey derives Ethereum
 * at m/44'/60' and Tron at m/44'/195', so they are *different keys*, and
 * signing with the wrong one produces a valid signature for an address that
 * holds nothing.
 */
async function tronAddress(tk: ReturnType<typeof useTurnkey>): Promise<string | undefined> {
  const find = (wallets: Awaited<ReturnType<typeof tk.fetchWallets>>) =>
    wallets.flatMap((w) => w.accounts).find((a) => a.addressFormat === "ADDRESS_FORMAT_TRON")?.address;

  let wallets = await tk.fetchWallets();
  const existing = find(wallets);
  if (existing) return existing;

  const walletId = wallets[0]?.walletId;
  if (!walletId) return undefined;
  await tk.createWalletAccounts({ walletId, accounts: [TRON_ACCOUNT] });
  wallets = await tk.fetchWallets();
  return find(wallets);
}
