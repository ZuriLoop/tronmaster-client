import { type Connection, type GaslessAccount, type TransferState, describeFee } from "@tron-paymaster/react";
import { formatUnits, toBase58 } from "@tron-paymaster/sdk";
import { Button } from "@tron-paymaster/theme/button";
import { Card, Field, inputClass } from "@tron-paymaster/theme/ui";
import { CheckCircle2, Loader2 } from "lucide-react";
import { useState } from "react";
import { USDT_DECIMALS, USDT_SYMBOL, defaultRelayer, explorerTx, repoUrl } from "../config.js";

const link = "font-medium text-primary underline underline-offset-4 dark:text-primary-glow";

/** The send flow: amount → quote → decoded preview → sign → status. */
export function SendPanel({
  account,
  connection,
  transfer,
  onDone,
}: {
  account: GaslessAccount;
  connection: Connection;
  transfer: TransferState;
  onDone(): void;
}) {
  const [relayerUrl, setRelayerUrl] = useState(defaultRelayer);
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const { phase, quote, txid, error } = transfer;
  const busy = phase === "quoting" || phase === "signing" || phase === "submitting" || phase === "pending";

  if (phase === "done") {
    return (
      <Card className="p-6 text-center">
        <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-primary/10 text-primary dark:text-primary-glow">
          <CheckCircle2 className="h-6 w-6" />
        </div>
        <h2 className="text-lg font-bold tracking-tight">Sent</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {amount} {USDT_SYMBOL} delivered. No TRX left your account.
        </p>
        {txid && (
          <p className="mt-3 text-sm">
            <a className={link} href={explorerTx(txid)} target="_blank" rel="noreferrer">
              View the transaction
            </a>
          </p>
        )}
        <Button
          type="button"
          variant="outline"
          className="mt-5 w-full rounded-xl"
          onClick={() => {
            transfer.reset();
            setTo("");
            setAmount("");
            onDone();
          }}
        >
          Send another
        </Button>
      </Card>
    );
  }

  return (
    <Card className="p-6">
      <h2 className="text-lg font-bold tracking-tight">Send {USDT_SYMBOL}</h2>

      <div className="mt-5 grid gap-4">
        {!defaultRelayer && (
          <Field
            label="Relayer"
            hint={
              <>
                A relayer submits your transfer and pays the network fee, charging you in USDT. Relaying is permissionless — you can{" "}
                <a className={link} href={`${repoUrl}#running-your-own-relayer`} target="_blank" rel="noreferrer">
                  run your own
                </a>
                .
              </>
            }
          >
            <input className={inputClass} value={relayerUrl} onChange={(e) => setRelayerUrl(e.target.value)} placeholder="https://…" spellCheck={false} />
          </Field>
        )}

        <Field label="Recipient Tron address">
          <input
            className={inputClass}
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="T…"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            disabled={!!quote}
          />
        </Field>

        <Field
          label="Amount"
          hint={
            <>
              Available {formatUnits(account.available, USDT_DECIMALS)} {USDT_SYMBOL}. A fee is taken from this balance in USDT — you will
              see the exact amount before you sign.
              {!account.deployed && " Your first transfer costs a little more, because it also creates your account on-chain."}
            </>
          }
        >
          <input className={inputClass} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" inputMode="decimal" disabled={!!quote} />
        </Field>
      </div>

      {!quote ? (
        <Button
          type="button"
          variant="hero"
          size="lg"
          className="mt-5 w-full rounded-xl"
          disabled={busy || !to || !amount || !relayerUrl}
          onClick={() => void transfer.getQuote({ relayerUrl, to, amount, available: account.available, deployed: account.deployed })}
        >
          {phase === "quoting" && <Loader2 className="h-4 w-4 animate-spin" />}
          {phase === "quoting" ? "Getting a quote…" : "Continue"}
        </Button>
      ) : (
        <>
          <div className="mt-5 rounded-2xl border border-foreground/10 bg-background p-4">
            <h3 className="text-[13px] font-semibold uppercase tracking-wider text-muted-foreground">Confirm</h3>
            <dl className="mt-3 grid gap-2.5 text-sm">
              <Line label="Send">
                {formatUnits(quote.permit.value, USDT_DECIMALS)} {USDT_SYMBOL}
              </Line>
              <Line label="To">
                <code className="break-all font-mono text-xs">{toBase58(quote.permit.to)}</code>
              </Line>
              <Line label="Fee (maximum)">
                {formatUnits(quote.permit.maxFee, USDT_DECIMALS)} {USDT_SYMBOL}
                {quote.deploysAccount && <span className="block text-xs text-muted-foreground">includes creating your account</span>}
                {/* Honest wording: the relayer fee is covered, the protocol fee
                    is still the user's and is included in this number. */}
                {quote.sponsored && <span className="block text-xs text-muted-foreground">the relayer fee is covered for you; this is the protocol fee</span>}
                {/* Where the price comes from. A fee is almost all energy, and
                    the price of energy moves hour to hour — saying which rule
                    applied is the difference between legible and suspicious. */}
                {describeFee(quote) && <span className="block text-xs text-muted-foreground">{describeFee(quote)}</span>}
              </Line>
              <Line label="Total taken">
                <strong>
                  {formatUnits(quote.totalDebit, USDT_DECIMALS)} {USDT_SYMBOL}
                </strong>
              </Line>
              <Line label="Valid until">{new Date(Number(quote.permit.deadline) * 1000).toLocaleTimeString()}</Line>
            </dl>
            <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
              Your wallet will show these same values as a signature request. It is an approval, not a transaction: it can be used once,
              only by this relayer, only for this recipient and amount, and never for more than the fee shown.
            </p>
          </div>
          <div className="mt-4 grid gap-2">
            <Button type="button" variant="hero" size="lg" className="w-full rounded-xl" disabled={busy} onClick={() => void transfer.send({ relayerUrl, signer: connection.signer })}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {phase === "signing" ? "Check your wallet…" : phase === "submitting" ? "Submitting…" : phase === "pending" ? "Confirming on Tron…" : "Sign and send"}
            </Button>
            <Button type="button" variant="ghost" className="w-full rounded-xl" disabled={busy} onClick={() => transfer.reset()}>
              Back
            </Button>
          </div>
        </>
      )}

      {error && (
        <p className="mt-4 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm leading-relaxed text-destructive" role="alert">
          {error}
        </p>
      )}
      {txid && (
        <p className="mt-3 text-xs">
          <a className={link} href={explorerTx(txid)} target="_blank" rel="noreferrer">
            Track the transaction
          </a>
        </p>
      )}
    </Card>
  );
}

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </div>
  );
}
