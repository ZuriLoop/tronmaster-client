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
    const { signMode } = cfg;

    const signIn = async (): Promise<Connection> => {
      // `handleLogin` only OPENS the modal — it resolves as soon as the page
      // is pushed, not when the person has authenticated. Everything below
      // needs a session, so wait for one rather than racing it.
      if (!latest.current.session) {
        await latest.current.handleLogin();
        await waitForSession(() => latest.current.session);
      }

      const t = latest.current;
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
          organizationId: t.session?.organizationId,
          mode: signMode,
        }),
        // Turnkey can sign Tron transactions, but this app never asks it to —
        // the owner-exit path is a separate tool, not a browser flow.
        canSignTronTx: false,
      };
    };

    return registerWallet({
      kind: "embedded",
      id: WALLET_ID,
      name: "Passkey",
      async connect(): Promise<Connection> {
        try {
          return await signIn();
        } catch (e) {
          throw new Error(readTurnkeyError(e));
        }
      },
    });
  }, []);

  return null;
}

/**
 * Turnkey's errors carry the useful part in `details`, not in `message`.
 *
 * A rejected request reads only "invalid request" at the top level, while the
 * field that was wrong sits in a nested fieldViolations list — so surfacing
 * `.message` alone tells a user, and whoever they report it to, nothing.
 */
function readTurnkeyError(e: unknown): string {
  const err = e as { message?: string; details?: Array<{ fieldViolations?: Array<{ field?: string; description?: string }> }> };
  const violations = (err?.details ?? []).flatMap((d) => d.fieldViolations ?? []);
  const detail = violations.map((v) => [v.field, v.description].filter(Boolean).join(": ")).join("; ");
  const base = err?.message || "sign-in failed";
  return detail ? `${base} — ${detail}` : base;
}

/**
 * Waits for the person to finish signing in.
 *
 * There is no promise to await on: the modal is a page the provider pushes,
 * and the session appears in context when it closes successfully. Polling it
 * is the honest way to express "when they are done". Closing the modal without
 * signing in simply never produces one, so this ends at the deadline with a
 * message rather than hanging forever.
 */
async function waitForSession(get: () => unknown, timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!get()) {
    if (Date.now() > deadline) throw new Error("sign-in was not completed");
    await new Promise((r) => setTimeout(r, 200));
  }
}

/**
 * The account to sign with, creating it if this sub-organization has none.
 *
 * It must be the Tron-derived account specifically: Turnkey derives Ethereum
 * at m/44'/60' and Tron at m/44'/195', so they are *different keys*, and
 * signing with the wrong one produces a valid signature for an address that
 * holds nothing.
 */
async function tronAddress(tk: ReturnType<typeof useTurnkey>): Promise<string | undefined> {
  type Wallets = Awaited<ReturnType<typeof tk.fetchWallets>>;
  const find = (wallets: Wallets) => wallets.flatMap((w) => w.accounts).find((a) => a.addressFormat === "ADDRESS_FORMAT_TRON")?.address;

  // `fetchWallets` also reports wallets CONNECTED from the browser — an
  // installed MetaMask shows up here — and those have no Turnkey wallet id to
  // add an account to. Only a wallet Turnkey itself holds will do, and its id
  // is a v4 UUID.
  const held = (wallets: Wallets) => wallets.filter((w) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(w.walletId));

  let wallets = await tk.fetchWallets();
  const existing = find(wallets);
  if (existing) return existing;

  const walletId = held(wallets)[0]?.walletId;
  if (walletId) {
    // A wallet exists but was created with Ethereum/Solana accounts only.
    await tk.createWalletAccounts({ walletId, accounts: [TRON_ACCOUNT] });
  } else {
    // A sub-organization with no Turnkey-held wallet at all.
    await tk.createWallet({ walletName: "tron", accounts: [TRON_ACCOUNT] });
  }

  wallets = await tk.fetchWallets();
  return find(wallets);
}
