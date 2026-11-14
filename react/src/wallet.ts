import { type Eip1193Provider, type EvmNetwork, type PermitSigner, TRON_EVM_NETWORKS, fromEip1193, fromInjectedTron, parseTronAddress } from "@tron-paymaster/sdk";

/**
 * Wallet connection. Two kinds are supported, and the difference that matters
 * to the user is not the brand but whether the wallet can sign *Tron
 * transactions*:
 *
 * - `tron` (TronLink and friends): signs both permits and Tron transactions,
 *   so the owner can also exit on their own by paying TRX.
 * - `evm` (MetaMask, Rabby, any EIP-1193): signs permits only — which is all
 *   the protocol needs, because Tron and Ethereum share secp256k1 and a
 *   permit is EIP-712 typed data. Such a user can always reach their funds
 *   without us by importing the SAME key into a Tron wallet.
 * - `embedded`: a wallet with no browser extension at all, where a service
 *   holds the key and signs on the user's authority (a passkey, say). It
 *   cannot be detected, so the host app registers it — see `registerWallet`.
 */
export type WalletKind = "tron" | "evm" | "embedded";

export interface Connection {
  kind: WalletKind;
  /** The wallet that was chosen, so a reconnect goes to the same one. */
  id: string;
  /** Wallet name as reported by the provider, for display. */
  name: string;
  /** The owner address (20-byte hex); the same bytes are its Tron address. */
  owner: string;
  signer: PermitSigner;
  /** True when the wallet can sign Tron transactions (owner-exit without a relayer). */
  canSignTronTx: boolean;
}

interface TronLinkWindow {
  tronLink?: { request(a: { method: string }): Promise<unknown>; tronWeb?: TronWebLike };
  tronWeb?: TronWebLike;
  ethereum?: Eip1193Provider & { isMetaMask?: boolean; isRabby?: boolean; providers?: unknown[] };
}

/**
 * EIP-6963 provider discovery.
 *
 * `window.ethereum` is one slot that every injected wallet fights over, so
 * with more than one installed it holds whichever extension loaded last — and
 * several of them set `isMetaMask: true` on purpose, so the name cannot be
 * trusted either. The result is an app that connects to a wallet the user did
 * not pick.
 *
 * EIP-6963 fixes this: the page asks, and each wallet announces itself with a
 * stable `rdns` id, its real name and an icon. We list them all and let the
 * user choose. `window.ethereum` is used only as a fallback for wallets too
 * old to announce.
 */
interface Eip6963Detail {
  info: { uuid: string; name: string; icon: string; rdns: string };
  provider: Eip1193Provider;
}

const announced = new Map<string, Eip6963Detail>();

if (typeof window !== "undefined") {
  window.addEventListener("eip6963:announceProvider", (e) => {
    const d = (e as CustomEvent<Eip6963Detail>).detail;
    if (d?.info?.rdns) announced.set(d.info.rdns, d);
  });
  // Wallets that are already loaded answer this synchronously; the rest
  // announce themselves as they inject, which the poll in useWallet picks up.
  window.dispatchEvent(new Event("eip6963:requestProvider"));
}

/** Re-asks, for wallets that injected after the first request. */
export function requestProviders(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event("eip6963:requestProvider"));
}
interface TronWebLike {
  defaultAddress?: { base58?: string };
  trx: { _signTypedData(domain: unknown, types: unknown, message: unknown): Promise<string> };
}

const w = () => window as unknown as TronLinkWindow;

export interface Available {
  kind: WalletKind;
  name: string;
  /** Stable identity to connect with: an EIP-6963 `rdns`, or "tron"/"injected". */
  id: string;
  /** data: URI from the wallet, when it announced one. */
  icon?: string;
}

/** A wallet contributed by the host app rather than found in the browser. */
export interface RegisteredWallet extends Available {
  connect(): Promise<Connection>;
}

const registered = new Map<string, RegisteredWallet>();

/**
 * Adds a wallet that cannot be detected.
 *
 * `detectWallets` is a presence probe — it looks for injected globals — so a
 * wallet that lives behind a service rather than an extension is invisible to
 * it, and invisible wallets cannot be offered, remembered or reconnected.
 * Registering one puts it in the same list as the extensions and nothing
 * downstream needs to know the difference.
 *
 * Kept generic on purpose: this package stays free of any particular
 * provider's SDK, and the host app owns that dependency.
 *
 * Returns a function that removes it again.
 */
export function registerWallet(wallet: RegisteredWallet): () => void {
  registered.set(wallet.id, wallet);
  return () => {
    registered.delete(wallet.id);
  };
}

/** Which wallets this browser actually has — every one of them, by name. */
export function detectWallets(): Available[] {
  const out: Available[] = [];
  const win = w();
  // Registered first: on a machine with no extension it is the only way in,
  // and that is exactly when it must not be buried.
  for (const r of registered.values()) out.push({ kind: r.kind, id: r.id, name: r.name, icon: r.icon });
  if (win.tronLink || win.tronWeb) out.push({ kind: "tron", id: "tron", name: win.tronLink ? "TronLink" : "Tron wallet" });
  for (const d of announced.values()) {
    out.push({ kind: "evm", id: d.info.rdns, name: d.info.name, icon: d.info.icon });
  }
  // Only when nothing announced: a wallet too old for EIP-6963.
  if (!announced.size && win.ethereum) {
    const e = win.ethereum;
    out.push({ kind: "evm", id: "injected", name: e.isMetaMask ? "MetaMask" : e.isRabby ? "Rabby" : "Browser wallet" });
  }
  return out;
}

function evmProvider(id?: string): { provider: Eip1193Provider; name: string } {
  if (id && id !== "injected") {
    const d = announced.get(id);
    if (!d) throw new Error("that wallet is no longer available — reload the page and pick it again");
    return { provider: d.provider, name: d.info.name };
  }
  const eth = w().ethereum;
  if (!eth) throw new Error("no EVM wallet found in this browser");
  return { provider: eth, name: eth.isMetaMask ? "MetaMask" : eth.isRabby ? "Rabby" : "Browser wallet" };
}

export async function connect(kind: WalletKind, network?: EvmNetwork, id?: string): Promise<Connection> {
  // By id first: a registered wallet knows how to connect itself.
  const r = id ? registered.get(id) : undefined;
  if (r) return r.connect();
  if (kind === "tron") return connectTron();
  if (kind === "evm") return connectEvm(network, id);
  throw new Error(`no ${kind} wallet is registered — reload the page and pick one again`);
}

async function connectTron(): Promise<Connection> {
  const win = w();
  const link = win.tronLink;
  if (link?.request) {
    // Prompts TronLink to unlock / authorize this site.
    await link.request({ method: "tron_requestAccounts" }).catch(() => undefined);
  }
  const tronWeb = link?.tronWeb ?? win.tronWeb;
  const base58 = tronWeb?.defaultAddress?.base58;
  if (!tronWeb || !base58) throw new Error("TronLink is locked or did not authorize this site — open the extension and try again");
  return {
    kind: "tron",
    id: "tron",
    name: link ? "TronLink" : "Tron wallet",
    owner: parseTronAddress(base58),
    signer: fromInjectedTron(tronWeb as Parameters<typeof fromInjectedTron>[0]),
    canSignTronTx: true,
  };
}

async function connectEvm(network?: EvmNetwork, id?: string): Promise<Connection> {
  const { provider: eth, name } = evmProvider(id);
  const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
  const account = accounts?.[0];
  if (!account) throw new Error("the wallet returned no account");
  return {
    kind: "evm",
    id: id ?? "injected",
    name,
    owner: parseTronAddress(account),
    // MetaMask refuses to sign typed data for a chain it is not on, so the
    // signer adds/switches to Tron (TronGrid speaks eth_* JSON-RPC) first.
    signer: fromEip1193(eth, account, network),
    canSignTronTx: false,
  };
}

/** Fires when the connected account changes, so the UI can re-derive everything. */
export function onAccountChange(kind: WalletKind, cb: () => void, id?: string): () => void {
  const win = w();
  // A registered wallet has no account to change behind our back: its session
  // is the app's own. Listening on the page's wallet globals would only
  // deliver another wallet's events.
  if (id && registered.has(id)) return () => undefined;
  if (kind === "evm") {
    // Listen on the provider that was actually connected, not on whatever
    // currently owns window.ethereum.
    const chosen = id && id !== "injected" ? announced.get(id)?.provider : win.ethereum;
    if (!chosen) return () => undefined;
    const p = chosen as Eip1193Provider & { on?: (e: string, h: () => void) => void; removeListener?: (e: string, h: () => void) => void };
    p.on?.("accountsChanged", cb);
    return () => p.removeListener?.("accountsChanged", cb);
  }
  // TronLink announces account changes by posting a message to the page.
  const handler = (e: MessageEvent) => {
    const m = (e.data as { message?: { action?: string } } | undefined)?.message;
    if (m?.action === "accountsChanged" || m?.action === "setAccount") cb();
  };
  window.addEventListener("message", handler);
  return () => window.removeEventListener("message", handler);
}
