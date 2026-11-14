import { type Permit, type PermitSigner, createRelayerClient, parseTronAddress, parseUnits, signPermit } from "@tron-paymaster/sdk";
import { useCallback, useState } from "react";
import { formatUnits } from "@tron-paymaster/sdk";
import { useTronPaymaster } from "./context.js";

export type TransferPhase = "idle" | "quoting" | "ready" | "signing" | "submitting" | "pending" | "done" | "failed";

export interface Quoted {
  permit: Permit;
  quoteId: string;
  account: string;
  expectedSigner: string;
  relayerFee: bigint;
  protocolFee: bigint;
  /** value + maxFee: everything that leaves the account. */
  totalDebit: bigint;
  deploysAccount: boolean;
  /** An app's policy is paying the relayer fee: `relayerFee` is 0. */
  sponsored: boolean;
  /** Why a requested sponsorship was declined. The transfer is still payable. */
  sponsorshipDeclined?: string;
  /** Why this price is this price, when the relayer says. See `describeFee`. */
  energyPriceSun?: bigint;
  feeBasis?: "cost-plus" | "stake-flat" | "floor";
}

/**
 * One line explaining where a fee comes from, or nothing.
 *
 * A fee is almost entirely the energy behind it, and the price of energy
 * moves with where the relayer can buy it — so the same transfer can be
 * quoted at very different numbers within an hour. Saying which rule applied
 * turns that from suspicious into legible.
 *
 * The wording tracks what is actually known. A relayer reports the basis it
 * PRICED on, not which units it will spend: the chain reports own stake and
 * every delegation as one balance, so no finer claim would be true. Nothing
 * here is load-bearing — a relayer may send none of it, and the fee charged
 * is the one in the signed permit either way.
 */
export function describeFee(q: Pick<Quoted, "feeBasis" | "energyPriceSun" | "sponsored">): string | undefined {
  if (q.sponsored) return undefined; // the sponsored note already explains this one
  const rate = q.energyPriceSun === undefined ? undefined : `${q.energyPriceSun} sun per energy`;
  if (q.feeBasis === "floor") return rate ? `the relayer's minimum fee — energy is ${rate} right now` : "the relayer's minimum fee";
  if (q.feeBasis === "stake-flat") return "a flat rate, served from the relayer's own staked energy";
  if (q.feeBasis === "cost-plus") return rate ? `what the energy costs, at ${rate}, plus the relayer's margin` : "what the energy costs, plus the relayer's margin";
  return rate ? `energy is ${rate} right now` : undefined;
}

export interface TransferState {
  phase: TransferPhase;
  quote?: Quoted;
  txid?: string;
  error?: string;
  getQuote(p: { relayerUrl?: string; to: string; amount: string; available: bigint; deployed: boolean }): Promise<void>;
  send(p: { relayerUrl?: string; signer: PermitSigner }): Promise<void>;
  reset(): void;
}

/**
 * Recipient validation. `parseTronAddress` deliberately accepts `0x…` and
 * `41…` hex as well as base58 — fine for a library, catastrophic in a send
 * box: an Ethereum/BSC deposit address pasted here is a *valid* Tron address
 * and the funds are burned. A consumer app accepts base58 only.
 */
export function validateRecipient(input: string): { ok: true; address: string } | { ok: false; reason: string } {
  const v = input.trim();
  if (!v) return { ok: false, reason: "Enter the recipient's Tron address." };
  if (v.startsWith("0x")) {
    return { ok: false, reason: "That looks like an Ethereum-style address. Tron addresses start with T — sending to an Ethereum address here would lose the funds permanently." };
  }
  if (!v.startsWith("T")) return { ok: false, reason: "A Tron address starts with T." };
  try {
    return { ok: true, address: parseTronAddress(v) };
  } catch {
    return { ok: false, reason: "That address is not valid — check it for a typo. Tron addresses are 34 characters and start with T." };
  }
}

/** Turns any failure into something a non-technical user can act on. */
export function explain(e: unknown): string {
  const raw = (e as Error)?.message ?? String(e);
  const m = raw.toLowerCase();
  // Checked before the wallet-rejection branch below, which must not claim
  // the user declined something a sponsor did.
  if (m.includes("sponsorship declined")) {
    // The signed permit covers the protocol fee only, so there is nothing to
    // fall back to: the quote has to be redone at the user's own expense.
    return "The sponsor stopped covering this transfer before it was sent. Get a fresh quote — you can still send it yourself.";
  }
  // "declined" alone is too broad to mean the wallet: it appears in messages
  // about policies and relayers too. Pairing it with "user" keeps TronLink's
  // "Confirmation declined by user" and MetaMask's "user declined" alike.
  if (m.includes("user rejected") || m.includes("user denied") || m.includes("4001") || (m.includes("declin") && m.includes("user"))) {
    return "You declined the signature in your wallet. Nothing was sent.";
  }
  if (m.includes("energy unavailable")) {
    return "This relayer has run out of network capacity and is not accepting transfers right now. Try again shortly, or use a different relayer — anyone can run one.";
  }
  if (m.includes("insufficient balance")) return "This account does not hold enough USDT to cover the amount plus the fee.";
  if (m.includes("expired")) return "The quote expired before it was signed. Get a fresh quote and try again.";
  if (m.includes("not current")) return "Another transfer from this account went through first. Get a fresh quote and try again.";
  if (m.includes("does not recover")) return "Your wallet produced a signature for a different account. Check which account is selected and try again.";
  if (m.includes("does not match the request") || m.includes("exceeds your maxfee")) {
    return "The relayer quoted something different from what you asked for, so the request was refused. Try a different relayer.";
  }
  if (m.includes("failed to fetch") || m.includes("networkerror") || m.includes("load failed")) {
    return "Could not reach the relayer. Check the relayer URL or your connection.";
  }
  if (m.includes("invalid tron address") || m.includes("checksum")) return "That recipient address is not a valid Tron address.";
  return raw;
}

export function useTransfer(owner?: string): TransferState {
  const { client, token, decimals, relayerUrl: configuredRelayer, apiKey, sponsorshipPolicyId } = useTronPaymaster();
  const [phase, setPhase] = useState<TransferPhase>("idle");
  const [quote, setQuote] = useState<Quoted>();
  const [txid, setTxid] = useState<string>();
  const [error, setError] = useState<string>();

  const reset = useCallback(() => {
    setPhase("idle");
    setQuote(undefined);
    setTxid(undefined);
    setError(undefined);
  }, []);

  const getQuote = useCallback<TransferState["getQuote"]>(
    async ({ relayerUrl, to, amount, available, deployed }) => {
      if (!owner) return;
      setPhase("quoting");
      setError(undefined);
      setTxid(undefined);
      try {
        const checked = validateRecipient(to);
        if (!checked.ok) throw new Error(checked.reason);
        const recipient = checked.address;
        const value = parseUnits(amount.trim(), decimals);
        if (value <= 0n) throw new Error("Enter an amount greater than zero.");
        if (value > available) throw new Error("insufficient balance");

        const url = relayerUrl ?? configuredRelayer;
        if (!url) throw new Error("no relayer configured — pass relayerUrl or set it on the provider");
        const relayer = createRelayerClient({ url, apiKey });
        // quote() verifies the relayer's permit against this request and
        // bounds the fee and deadline; a dishonest relayer throws here. It
        // also refuses a quote that claims to be sponsored while still
        // charging a relayer fee.
        const q = await relayer.quote({ owner, token, to: recipient, value, sponsorshipPolicyId });
        // Independently confirm the account and nonce against the chain.
        const state = await client.getAccountState(owner);
        if (q.account !== state.address || BigInt(q.nonce) !== state.nonce) {
          throw new Error("the relayer quoted something that does not match the request");
        }
        const maxFee = q.unsignedPermit.maxFee;
        if (value + maxFee > available) {
          // Distinguish "too small to be worth moving" from "not enough",
          // because a balance below the fee floor can never be sent at all.
          throw new Error(value <= maxFee ? `the fee for this transfer is more than the amount — amounts under about ${formatUnits(maxFee, decimals)} cost more to move than they are worth` : "insufficient balance");
        }
        setQuote({
          permit: q.unsignedPermit,
          quoteId: q.quoteId,
          account: state.address,
          expectedSigner: state.signer,
          relayerFee: BigInt(q.relayerFee),
          protocolFee: BigInt(q.protocolFee),
          totalDebit: value + maxFee,
          deploysAccount: !deployed,
          sponsored: q.sponsored === true,
          ...(q.feeBasis ? { feeBasis: q.feeBasis } : {}),
          ...(q.energyPriceSun ? { energyPriceSun: BigInt(q.energyPriceSun) } : {}),
          ...(sponsorshipPolicyId && !q.sponsored ? { sponsorshipDeclined: q.sponsorship?.reason ?? "this transfer is not covered" } : {}),
        });
        setPhase("ready");
      } catch (e) {
        setError(explain(e));
        setPhase("idle");
      }
    },
    [owner, client, token, decimals, configuredRelayer, apiKey, sponsorshipPolicyId],
  );

  const send = useCallback<TransferState["send"]>(
    async ({ relayerUrl, signer }) => {
      if (!quote) return;
      setError(undefined);
      try {
        setPhase("signing");
        // Verified locally against the account's signer before it leaves the page.
        const sig = await signPermit(signer, quote.permit, { account: quote.account, chainId: await client.getChainId() }, { expectedSigner: quote.expectedSigner });

        setPhase("submitting");
        const url = relayerUrl ?? configuredRelayer;
        if (!url) throw new Error("no relayer configured");
        const relayer = createRelayerClient({ url, apiKey });
        const sub = await relayer.submit({
          permit: quote.permit,
          signature: sig,
          quoteId: quote.quoteId,
          // Stable per permit: a retry can never pay twice.
          idempotencyKey: `app:${quote.account}:${quote.permit.nonce}`,
        });
        setTxid(sub.txid);
        setPhase("pending");

        const st = await relayer.waitForPermit(sub.id);
        setTxid(st.txid ?? sub.txid);
        if (st.status !== "INCLUDED") throw new Error(st.error ?? `transfer ${st.status}`);
        setPhase("done");
      } catch (e) {
        setError(explain(e));
        setPhase("failed");
      }
    },
    [quote, client, configuredRelayer],
  );

  return { phase, quote, txid, error, getQuote, send, reset };
}
