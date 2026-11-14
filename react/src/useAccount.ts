import { type AccountState } from "@tron-paymaster/sdk";
import { useCallback, useEffect, useState } from "react";
import { useTronPaymaster } from "./context.js";

export interface GaslessAccount extends AccountState {
  /** Raw USDT held by the account. */
  balance: bigint;
  /**
   * What the user can actually spend. Relayer fees accrue as a debt inside
   * the account until claimed, so the raw balance overstates this — showing
   * `balance` would make "send max" fail with an unexplained rejection.
   */
  available: bigint;
}

export interface AccountHook {
  account?: GaslessAccount;
  loading: boolean;
  error?: string;
  refresh(): void;
}

/**
 * The user's gasless account: its address is derived from their key and is
 * valid (and fundable) before any contract exists there, so this works from
 * the moment a wallet connects.
 */
export function useAccount(owner?: string, pollMs = 12_000): AccountHook {
  const { client, token } = useTronPaymaster();
  const [account, setAccount] = useState<GaslessAccount>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!owner) {
      setAccount(undefined);
      return;
    }
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const state = await client.getAccountState(owner);
        const { balance, available } = await client.getAccountBalances(state.address, token);
        if (!cancelled) {
          setAccount({ ...state, balance, available });
          setError(undefined);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    const timer = setInterval(load, pollMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [owner, pollMs, tick, client, token]);

  return { account, loading, error, refresh };
}
