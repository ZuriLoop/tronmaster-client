import type { WalletState } from "@tron-paymaster/react";
import { Button } from "@tron-paymaster/theme/button";
import { Card } from "@tron-paymaster/theme/ui";
import { Wallet } from "lucide-react";

const link = "font-medium text-primary underline underline-offset-4 dark:text-primary-glow";

/**
 * Wallet choice. Both kinds sign permits; only a Tron wallet can also sign
 * Tron transactions, which matters solely for withdrawing without a relayer.
 * That difference is stated here rather than discovered later.
 */
export function Connect({ wallet }: { wallet: WalletState }) {
  const { available, connecting, error } = wallet;

  if (!available.length) {
    return (
      <Card className="p-6 text-center">
        <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-foreground/[0.06] text-muted-foreground">
          <Wallet className="h-5 w-5" />
        </div>
        <h2 className="font-semibold">No wallet detected</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Install{" "}
          <a className={link} href="https://www.tronlink.org/" target="_blank" rel="noreferrer">
            TronLink
          </a>{" "}
          or{" "}
          <a className={link} href="https://metamask.io/" target="_blank" rel="noreferrer">
            MetaMask
          </a>{" "}
          — either works. On a phone, open this page inside your wallet's built-in browser.
        </p>
      </Card>
    );
  }

  return (
    <Card className="p-6">
      <h2 className="text-lg font-bold tracking-tight">Connect a wallet</h2>
      <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
        Your wallet holds the key. This page never sees it and cannot move your funds.
      </p>
      {/* An embedded wallet is the one option that works on a machine with
          nothing installed, so it earns a sentence rather than only a button. */}
      {available.some((a) => a.kind === "embedded") && (
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          No wallet? <strong className="text-foreground">Passkey</strong> makes one in a few seconds — your
          device authorises it, and there is no extension to install and no phrase to write down.
        </p>
      )}
      <div className="mt-5 grid gap-2.5">
        {available.map((a) => (
          <Button
            key={a.id}
            type="button"
            variant="hero"
            size="lg"
            className="w-full justify-start gap-3 rounded-xl"
            disabled={connecting}
            onClick={() => void wallet.connect(a.kind, a.id)}
          >
            {a.icon ? <img src={a.icon} alt="" aria-hidden className="h-5 w-5 rounded" /> : <Wallet className="h-5 w-5" />}
            {connecting ? "Connecting…" : `Connect ${a.name}`}
          </Button>
        ))}
      </div>
      {available.some((a) => a.kind === "evm") && !available.some((a) => a.kind === "tron") && (
        <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
          MetaMask has no Tron support — it does not need any. Tron uses the same key format, and the approval it shows you is ordinary
          typed data.
        </p>
      )}
      {error && (
        <p className="mt-4 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </Card>
  );
}
