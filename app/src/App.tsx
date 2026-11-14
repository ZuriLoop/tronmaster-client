import { useAccount, useTransfer, useWallet } from "@tron-paymaster/react";
import { Card, Logo, Skeleton, Tag, ThemeToggle } from "@tron-paymaster/theme/ui";
import { Connect } from "./components/Connect.js";
import { ReceiveCard } from "./components/ReceiveCard.js";
import { SendPanel } from "./components/SendPanel.js";
import { USDT_SYMBOL, chain, isTestnet } from "./config.js";

export function App() {
  const wallet = useWallet();
  const owner = wallet.connection?.owner;
  const { account, error: accountError, refresh } = useAccount(owner);
  const transfer = useTransfer(owner);

  return (
    <div className="relative min-h-screen">
      {/* A wash of the brand gradient, not a block of it: this is a wallet,
          and a wallet should feel calm. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-64 bg-gradient-primary opacity-[0.07] blur-3xl" aria-hidden />

      <div className="relative mx-auto w-full max-w-md px-4 pb-16 pt-5">
        <header className="mb-6 flex items-center justify-between gap-3">
          <Logo />
          <div className="flex items-center gap-2">
            {isTestnet && <Tag tone="pending">{chain.name} testnet</Tag>}
            <ThemeToggle />
          </div>
        </header>

        <h1 className="text-[27px] font-bold leading-tight tracking-tight">Send {USDT_SYMBOL} without TRX</h1>
        <p className="mb-6 mt-1.5 text-sm leading-relaxed text-muted-foreground">
          A gasless Tron account you control with the wallet you already have.
        </p>

        {!wallet.connection ? (
          <Connect wallet={wallet} />
        ) : (
          <div className="grid gap-5">
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="truncate text-muted-foreground">
                {wallet.connection.name} · <code className="font-mono">{wallet.connection.owner.slice(0, 6)}…{wallet.connection.owner.slice(-4)}</code>
              </span>
              <button type="button" className="shrink-0 font-medium text-muted-foreground underline underline-offset-4 transition-colors hover:text-foreground" onClick={wallet.disconnect}>
                disconnect
              </button>
            </div>

            {accountError && (
              <p className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive" role="alert">
                Could not read the network: {accountError}
              </p>
            )}

            {/* Reading the account is a round trip to Tron. Showing its shape
                while it arrives beats an empty screen that looks broken. */}
            {!account && !accountError && (
              <Card className="grid gap-4 p-6" aria-busy>
                <Skeleton className="h-3 w-32" />
                <Skeleton className="h-9 w-40" />
                <Skeleton className="mx-auto h-44 w-44 rounded-2xl" />
                <Skeleton className="h-11 w-full rounded-xl" />
                <span className="sr-only">Loading your account…</span>
              </Card>
            )}

            {account && (
              <>
                <ReceiveCard account={account} walletName={wallet.connection.name} />
                <SendPanel account={account} connection={wallet.connection} transfer={transfer} onDone={refresh} />
              </>
            )}
          </div>
        )}

      </div>
    </div>
  );
}
