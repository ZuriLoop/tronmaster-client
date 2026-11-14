import { type TronAddress, parseTronAddress, sameAddress } from "./address.js";
import { type Permit, type SerializedPermit, deserializePermit, serializePermit } from "./permit.js";
import type { PermitSignature } from "./sign.js";

/**
 * Relayer HTTP protocol (v1). Any relayer implementing it is interchangeable;
 * no API key or registration is part of the protocol.
 *
 * POST /v1/quote   QuoteRequest  -> Quote
 * POST /v1/submit  SubmitRequest -> SubmitResult   (honours `Idempotency-Key`)
 * GET  /v1/status/:id-or-txid     -> Status
 * GET  /v1/info                   -> RelayerInfo
 * POST /v1/sponsorship/validate   -> { policies, cost }  (optional; 404 when
 *                                     the relayer offers no sponsorship)
 *
 * Relayers may additionally accept an `x-api-key` header (for spend limits
 * and usage metering); relaying itself never requires one by protocol.
 */
export interface QuoteRequest {
  owner: string;
  index?: string;
  token: string;
  to: string;
  value: string;
  /**
   * Ask this policy to pay the relayer fee instead of the user. A relayer that
   * declines still returns an ordinary priced quote, with the reason attached:
   * check `sponsored` rather than assuming.
   */
  sponsorshipPolicyId?: string;
}

export interface Quote {
  /** Bind this into `permit.relayer`; fees credit only this address. */
  relayer: TronAddress;
  relayerFee: string;
  protocolFee: string;
  maxFee: string;
  account: TronAddress;
  nonce: string;
  deadline: string;
  chainId: number;
  factory: TronAddress;
  /** Unsigned permit fields, ready to sign. */
  permit: SerializedPermit;
  /** Opaque, HMAC-authenticated by the relayer; echo it back on submit. */
  quoteId: string;
  expiresAt: number;
  /** True when a policy is paying the relayer fee: `relayerFee` is then "0". */
  sponsored?: boolean;
  /** Present when a policy was named: which one, and why it declined. */
  sponsorship?: { policyId?: string; reason?: string };

  /*
   * Why this price is this price. Informational: a relayer may omit all
   * three, and none of them changes what is charged — the fee a relayer will
   * honour is the one inside `quoteId`, which is signed, or one it recomputes
   * itself. Show them; never compute anything you rely on from them.
   */
  /** Energy this transfer is priced for (the scenario estimate, not a measurement). */
  energy?: number;
  /** sun per energy the quote was computed at: the desk's blended rate, or the burn price. */
  energyPriceSun?: string;
  /** Which rule set the fee: cost plus margin, the flat stake tier, or the relayer's minimum. */
  feeBasis?: "cost-plus" | "stake-flat" | "floor";
}

export interface SubmitRequest {
  permit: SerializedPermit;
  signature: { r: string; vs: string };
  index?: string;
  quoteId?: string;
}

/**
 * Submission lifecycle (the same states as Turnkey's send-transaction status):
 * INITIALIZED (accepted, txid fixed) → BROADCASTING (sent to the network) →
 * INCLUDED (executed successfully) | FAILED (rejected, reverted or expired; not retried).
 */
export type SubmissionStatus = "INITIALIZED" | "BROADCASTING" | "INCLUDED" | "FAILED";

export interface SubmitResult {
  /** Relayer submission id; poll it with `status`. */
  id: string;
  txid?: string;
  account: TronAddress;
  status: SubmissionStatus;
}

export interface Status {
  id: string;
  txid?: string;
  status: SubmissionStatus;
  blockNumber?: number;
  error?: string;
  energyUsed?: number;
  /**
   * How the relayer ACQUIRED the energy: "pool" (capacity it already held),
   * "rented" (bought for this submission) or "burn" (its bounded fallback).
   * Not a claim about which units were spent: the chain reports own stake and
   * every delegation as one balance.
   */
  energySource?: "pool" | "rented" | "burn";
  /** TRX burned by the relayer, in sun, once included. */
  feeSun?: string;
  updatedAt?: number;
}

export interface RelayerInfo {
  relayer: TronAddress;
  chainId: number;
  factory: TronAddress;
  tokens: TronAddress[];
  /** True when the relayer charges no relayer fee (operator-billed). */
  sponsor?: boolean;
  /** True when the relayer can sponsor individual transfers under a policy. */
  sponsorship?: boolean;
  version: string;
}

export interface SponsorshipValidation {
  policies: Array<{ policyId: string; sponsor: boolean; reason?: string }>;
  /** What the transfer would cost, token base units — what a policy is billed. */
  cost: string;
}

export class RelayerError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly url?: string,
  ) {
    super(message);
    this.name = "RelayerError";
  }
}

export interface RelayerClient {
  info(): Promise<RelayerInfo>;
  /**
   * Gets a quote and verifies the returned permit field-by-field against the
   * request before handing it back, so a malicious relayer cannot slip a
   * different recipient, amount, fee or deadline into what gets signed.
   * `maxFee` (token base units) and `maxDeadlineSeconds` (default 3600) bound
   * what a quote may ask for; above either, this throws instead of returning.
   */
  quote(req: {
    owner: string;
    index?: bigint | number;
    token: string;
    to: string;
    value: bigint;
    maxFee?: bigint;
    maxDeadlineSeconds?: number;
    /** Ask this policy to pay. Check `sponsored` on the result; a decline is not an error. */
    sponsorshipPolicyId?: string;
  }): Promise<Quote & { unsignedPermit: Permit }>;
  /**
   * Submits a signed permit. Pass a stable `idempotencyKey` to make retries
   * safe: the relayer returns the original submission instead of paying twice.
   */
  submit(req: {
    permit: Permit;
    signature: PermitSignature;
    index?: bigint | number;
    quoteId?: string;
    idempotencyKey?: string;
  }): Promise<SubmitResult & { relayer: string }>;
  /**
   * Which of these policies would pay for this transfer, and why not. Consumes
   * no budget, so it is safe to call before showing a user a price. Throws
   * `RelayerError` with status 404 against a relayer that offers no sponsorship.
   */
  validateSponsorship(req: {
    owner: string;
    index?: bigint | number;
    token: string;
    to: string;
    value: bigint;
    policyIds: string[];
  }): Promise<SponsorshipValidation>;
  /** Status by submission id or txid. */
  status(ref: string): Promise<Status>;
  /** Polls until INCLUDED or FAILED (throws on timeout). */
  waitForPermit(ref: string, opts?: { timeoutMs?: number; pollMs?: number }): Promise<Status>;
}

/**
 * Client for one or more relayers. Requests try each URL in order and fall
 * back on network/5xx errors; 4xx errors (bad permit) are not retried.
 */
export function createRelayerClient(opts: { url: string | string[]; fetch?: typeof fetch; timeoutMs?: number; apiKey?: string }): RelayerClient {
  const urls = (Array.isArray(opts.url) ? opts.url : [opts.url]).map((u) => u.replace(/\/$/, ""));
  const fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);

  async function request<T>(path: string, body?: unknown, only?: string, extraHeaders: Record<string, string> = {}): Promise<T & { _url: string }> {
    let last: unknown;
    for (const base of only ? [only] : urls) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20_000);
      try {
        const res = await fetchFn(`${base}${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            ...(body === undefined ? {} : { "content-type": "application/json" }),
            ...(opts.apiKey ? { "x-api-key": opts.apiKey } : {}),
            ...extraHeaders,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: ctrl.signal,
        });
        const json = (await res.json().catch(() => ({}))) as T & { error?: string };
        if (res.ok) return { ...json, _url: base };
        const err = new RelayerError(json.error ?? `HTTP ${res.status}`, res.status, base);
        if (res.status < 500) throw err;
        last = err;
      } catch (e) {
        if (e instanceof RelayerError && (e.status ?? 500) < 500) throw e;
        last = e;
      } finally {
        clearTimeout(timer);
      }
    }
    throw last instanceof Error ? last : new RelayerError("all relayers failed");
  }

  // The quote and submit must hit the same relayer (fee binding + quoteId).
  let quotedBy: string | undefined;

  const client: RelayerClient = {
    info: () => request<RelayerInfo>("/v1/info"),
    async quote(q) {
      const res = await request<Quote>("/v1/quote", {
        owner: q.owner,
        index: String(q.index ?? 0),
        token: q.token,
        to: q.to,
        value: q.value.toString(),
        ...(q.sponsorshipPolicyId ? { sponsorshipPolicyId: q.sponsorshipPolicyId } : {}),
      } satisfies QuoteRequest);
      quotedBy = res._url;
      const permit = deserializePermit(res.permit);
      const bad = (what: string): never => {
        throw new RelayerError(`relayer returned a permit that does not match the request (${what})`, undefined, res._url);
      };
      // What gets signed is the permit, so every field is checked against the
      // request and the quote itself. The relayer is never trusted.
      if (!sameAddress(permit.owner, q.owner)) bad("owner");
      if (!sameAddress(permit.token, q.token)) bad("token");
      if (!sameAddress(permit.to, q.to)) bad("recipient");
      if (permit.value !== q.value) bad("value");
      if (!sameAddress(permit.relayer, res.relayer)) bad("relayer binding");
      if (permit.nonce !== BigInt(res.nonce)) bad("nonce");
      const quotedFee = BigInt(res.relayerFee) + BigInt(res.protocolFee);
      if (permit.maxFee !== quotedFee) bad(`maxFee ${permit.maxFee} != quoted fees ${quotedFee}`);
      // A quote that claims to be sponsored must actually charge nothing but
      // the protocol fee, which the contract takes from the user regardless.
      if (res.sponsored && BigInt(res.relayerFee) !== 0n) bad("sponsored quote still charges a relayer fee");
      if (q.maxFee !== undefined && permit.maxFee > q.maxFee) {
        throw new RelayerError(`quoted fee ${permit.maxFee} exceeds your maxFee ${q.maxFee}`, undefined, res._url);
      }
      const deadlineCap = BigInt(Math.floor(Date.now() / 1000) + (q.maxDeadlineSeconds ?? 3600));
      if (permit.deadline > deadlineCap) {
        throw new RelayerError(`quoted deadline ${permit.deadline} is more than ${q.maxDeadlineSeconds ?? 3600}s away`, undefined, res._url);
      }
      return { ...res, unsignedPermit: permit };
    },
    async submit(s) {
      const res = await request<SubmitResult>(
        "/v1/submit",
        {
          permit: serializePermit(s.permit),
          signature: { r: s.signature.r, vs: s.signature.vs },
          index: String(s.index ?? 0),
          quoteId: s.quoteId,
        } satisfies SubmitRequest,
        quotedBy,
        s.idempotencyKey ? { "idempotency-key": s.idempotencyKey } : {},
      );
      const { _url, ...out } = res;
      return { ...out, relayer: _url };
    },
    async validateSponsorship(v) {
      const { _url, ...out } = await request<SponsorshipValidation>("/v1/sponsorship/validate", {
        owner: v.owner,
        index: String(v.index ?? 0),
        token: v.token,
        to: v.to,
        value: v.value.toString(),
        policyIds: v.policyIds,
      });
      return out;
    },
    async status(ref) {
      const { _url, ...s } = await request<Status>(`/v1/status/${encodeURIComponent(ref)}`, undefined, quotedBy);
      return s;
    },
    async waitForPermit(ref, w = {}) {
      const deadline = Date.now() + (w.timeoutMs ?? 120_000);
      for (;;) {
        const s = await client.status(ref);
        if (s.status === "INCLUDED" || s.status === "FAILED") return s;
        if (Date.now() > deadline) throw new RelayerError(`timed out waiting for ${ref} (last status ${s.status})`);
        await new Promise((r) => setTimeout(r, w.pollMs ?? 2000));
      }
    },
  };
  return client;
}
