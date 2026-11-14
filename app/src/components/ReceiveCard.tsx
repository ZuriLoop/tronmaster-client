import type { GaslessAccount } from "@tron-paymaster/react";
import { formatUnits, toBase58 } from "@tron-paymaster/sdk";
import { Card, Notice } from "@tron-paymaster/theme/ui";
import { Check, Copy } from "lucide-react";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { USDT_DECIMALS, USDT_SYMBOL, explorerAddress, faucetUrl, isTestnet } from "../config.js";

const link = "font-medium text-primary underline underline-offset-4 dark:text-primary-glow";

/**
 * The receive screen — and the single most important piece of copy in the
 * app. A new user's dangerous misconception is that this is their wallet's
 * Tron address, or that their existing balance will appear here. It is a
 * different address, and funds already sitting in a TRX-less wallet cannot be
 * moved into it. Saying so plainly, up front, prevents the only mistake here
 * that costs real money.
 */
export function ReceiveCard({ account, walletName }: { account: GaslessAccount; walletName: string }) {
  const address = toBase58(account.address);
  const [qr, setQr] = useState<string>();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void QRCode.toDataURL(address, { margin: 1, width: 320 })
      .then(setQr)
      .catch(() => setQr(undefined));
  }, [address]);

  const copy = async () => {
    await navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <Card className="p-6">
      <h2 className="text-[13px] font-semibold uppercase tracking-wider text-muted-foreground">Your gasless address</h2>
      <p className="mt-1 text-xs text-muted-foreground">Send USDT here. It is the only address on this page that holds your balance.</p>

      <p className="mt-2 text-4xl font-bold tabular-nums tracking-tight">
        {formatUnits(account.available, USDT_DECIMALS)} <span className="text-xl font-semibold text-muted-foreground">{USDT_SYMBOL}</span>
      </p>

      {/* White behind the QR in both themes: a dark-on-dark code does not scan. */}
      {qr && (
        <div className="mx-auto mt-5 w-fit rounded-2xl border border-foreground/10 bg-white p-3">
          <img className="h-44 w-44" src={qr} alt={`QR code for ${address}`} />
        </div>
      )}

      <button
        type="button"
        onClick={() => void copy()}
        className="mt-4 flex w-full items-center justify-between gap-3 rounded-xl border border-foreground/10 bg-background px-3 py-2.5 text-left transition-colors hover:border-foreground/25"
      >
        <code className="min-w-0 break-all font-mono text-[13px]">{address}</code>
        <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
          {copied ? <Check className="h-3.5 w-3.5 text-primary dark:text-primary-glow" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? "copied" : "copy"}
        </span>
      </button>

      <Notice className="mt-5">
        <strong>USDT only — and this is a new address, not {walletName}'s Tron address.</strong>
        <ul className="mt-2 list-disc space-y-1.5 pl-5">
          <li>Send USDT here from an exchange or from anyone, then spend it without ever holding TRX.</li>
          <li>USDT already in your ordinary Tron address will not appear here, and moving it here would itself cost TRX.</li>
          <li>
            <strong>Do not send TRX</strong> or other tokens to this address. You never need TRX here, and anything other than USDT may not
            be recoverable.
          </li>
        </ul>
      </Notice>

      <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
        It is derived from your own key, so it is yours before it exists on-chain: it can receive USDT today and deploys itself
        automatically on your first transfer.{" "}
        <a className={link} href={explorerAddress(address)} target="_blank" rel="noreferrer">
          View on the explorer
        </a>
        .
      </p>

      {isTestnet && (
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          Test network. Get free test USDT and TRX from the{" "}
          <a className={link} href={faucetUrl} target="_blank" rel="noreferrer">
            Nile faucet
          </a>
          .
        </p>
      )}
    </Card>
  );
}
