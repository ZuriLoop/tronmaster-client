import { useCallback, useEffect, useState } from "react";
import { TRON_EVM_NETWORKS } from "@tron-paymaster/sdk";
import { type Available, type Connection, type WalletKind, connect, detectWallets, onAccountChange, requestProviders } from "./wallet.js";
import { useTronPaymaster } from "./context.js";

const REMEMBERED = "tpm.wallet";

export interface WalletState {
  available: Available[];
  connection?: Connection;
  connecting: boolean;
  error?: string;
  /** `id` picks one specific wallet (an EIP-6963 rdns) when several are installed. */
  connect(kind: WalletKind, id?: string): Promise<void>;
  disconnect(): void;
}

export function useWallet(): WalletState {
  const { chain } = useTronPaymaster();
  const network = TRON_EVM_NETWORKS[chain.name];
  const [available, setAvailable] = useState<Available[]>([]);
  const [connection, setConnection] = useState<Connection>();
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string>();

  // Wallet extensions inject late; re-check briefly after load.
  useEffect(() => {
    const scan = () => {
      // Wallets announce on request; ask again as late injectors arrive.
      requestProviders();
      setAvailable(detectWallets());
    };
    scan();
    const t = setInterval(scan, 400);
    const stop = setTimeout(() => clearInterval(t), 3000);
    return () => {
      clearInterval(t);
      clearTimeout(stop);
    };
  }, []);

  const doConnect = useCallback(async (kind: WalletKind, id?: string) => {
    setConnecting(true);
    setError(undefined);
    try {
      const c = await connect(kind, network, id);
      setConnection(c);
      // Remember which wallet, not just which kind: reconnecting to a
      // different one than the user picked is the bug this replaces.
      localStorage.setItem(REMEMBERED, `${kind}:${c.id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setConnecting(false);
    }
  }, [network]);

  // Reconnect silently to the wallet used last time, once it is present.
  useEffect(() => {
    if (connection || connecting) return;
    const remembered = localStorage.getItem(REMEMBERED);
    if (!remembered) return;
    const [kind, id] = remembered.split(":") as [WalletKind, string | undefined];
    if (!available.some((a) => a.kind === kind && (!id || a.id === id))) return;
    connect(kind, network, id)
      .then(setConnection)
      .catch(() => undefined); // a locked wallet is not an error until the user asks
  }, [available, connection, connecting, network]);

  // Re-derive everything when the wallet switches accounts.
  useEffect(() => {
    if (!connection) return;
    return onAccountChange(
      connection.kind,
      () => {
        connect(connection.kind, network, connection.id)
          .then(setConnection)
          .catch(() => setConnection(undefined));
      },
      connection.id,
    );
  }, [connection, network]);

  const disconnect = useCallback(() => {
    localStorage.removeItem(REMEMBERED);
    setConnection(undefined);
  }, []);

  return { available, connection, connecting, error, connect: doConnect, disconnect };
}
