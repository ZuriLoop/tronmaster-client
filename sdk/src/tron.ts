import { type Hex, decodeErrorResult, hexToString, isHex, recoverAddress, sha256 } from "viem";
import { privateKeyToAccount, sign } from "viem/accounts";
import { type TronAddress, parseTronAddress, toTronHex } from "./address.js";
import { depositForwarderAbi, paymasterFactoryAbi, permitAccountAbi } from "./abi.js";
import { ContractType, type DecodedTransaction, ResourceCode, decodeTransactionRaw } from "./txproto.js";

/** Minimal java-tron HTTP API client (TronGrid or a self-hosted node). No TronWeb. */
export interface TronRpcOptions {
  url: string;
  /** TronGrid API key (sent as `TRON-PRO-API-KEY`). */
  apiKey?: string;
  fetch?: typeof fetch;
  /** Per-request timeout in ms (default 20s). */
  timeoutMs?: number;
  /**
   * Longest transaction expiration (from now) accepted from this node before
   * signing, so a node cannot hand back a tx it could hold and broadcast much
   * later. Default 1 hour; java-tron's default is 60 s. Raise it only for
   * nodes configured otherwise (tronbox/tre uses ~12 h).
   */
  maxTxExpiryMs?: number;
}

export interface TronTransaction {
  txID: string;
  raw_data: {
    contract: Array<{ type: string; parameter: { value: Record<string, unknown>; type_url?: string } }>;
    fee_limit?: number;
    [k: string]: unknown;
  };
  raw_data_hex: string;
  signature?: string[];
  visible?: boolean;
  contract_address?: string;
}

export interface TransactionInfo {
  id: string;
  blockNumber?: number;
  blockTimeStamp?: number;
  fee?: number;
  contract_address?: string;
  receipt?: {
    result?: string;
    energy_usage?: number;
    energy_fee?: number;
    origin_energy_usage?: number;
    energy_usage_total?: number;
    net_usage?: number;
    net_fee?: number;
  };
  result?: string;
  resMessage?: string;
  contractResult?: string[];
  log?: unknown[];
}

export class TronRpcError extends Error {
  constructor(
    message: string,
    readonly details?: unknown,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "TronRpcError";
  }
}

const strip0x = (h: string) => (h.startsWith("0x") ? h.slice(2) : h);
const decodeMsg = (m?: string) => {
  if (!m) return "";
  try {
    return /^[0-9a-f]+$/i.test(m) ? hexToString(`0x${m}`) : m;
  } catch {
    return m;
  }
};

const ALL_ABIS = [...paymasterFactoryAbi, ...permitAccountAbi, ...depositForwarderAbi];

/** Best-effort decoding of revert data into a custom error name. */
export function decodeRevert(data?: string): string | undefined {
  if (!data || data.length < 8) return undefined;
  const hex = (data.startsWith("0x") ? data : `0x${data}`) as Hex;
  try {
    const d = decodeErrorResult({ abi: ALL_ABIS, data: hex });
    return d.args?.length ? `${d.errorName}(${d.args.map(String).join(", ")})` : d.errorName;
  } catch {
    if (hex.startsWith("0x08c379a0")) {
      try {
        const d = decodeErrorResult({ abi: [{ type: "error", name: "Error", inputs: [{ type: "string", name: "m" }] }], data: hex });
        return `Error(${String(d.args[0])})`;
      } catch {}
    }
    return undefined;
  }
}

export class TronRpc {
  readonly url: string;
  private readonly apiKey?: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  readonly maxTxExpiryMs: number;

  constructor(opts: TronRpcOptions) {
    this.url = opts.url.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.maxTxExpiryMs = opts.maxTxExpiryMs ?? 3_600_000;
  }

  /** POST with retry on rate limits (429) and transient 5xx / network errors. */
  async post<T = Record<string, unknown>>(path: string, body: unknown): Promise<T> {
    const attempts = 5;
    for (let i = 0; ; i++) {
      try {
        return await this.postOnce<T>(path, body);
      } catch (e) {
        const retryable = e instanceof TronRpcError ? e.retryable : true;
        // Never retry a broadcast blindly: it may have been accepted.
        if (!retryable || i >= attempts - 1 || path === "/wallet/broadcasttransaction") throw e;
        await new Promise((r) => setTimeout(r, 400 * 2 ** i + Math.random() * 200));
      }
    }
  }

  private async postOnce<T>(path: string, body: unknown): Promise<T> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers["TRON-PRO-API-KEY"] = this.apiKey;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(`${this.url}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        throw new TronRpcError(`${path}: HTTP ${res.status} ${text.slice(0, 200)}`, undefined, res.status === 429 || res.status >= 500);
      }
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new TronRpcError(`${path}: non-JSON response ${text.slice(0, 200)}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /** TIP-712 chain id: genesis block id & 0xffffffff (what TVM `CHAINID` masks to). */
  async getChainId(): Promise<number> {
    const b = await this.post<{ blockID?: string }>("/wallet/getblockbynum", { num: 0 });
    if (!b.blockID) throw new TronRpcError("could not read genesis block");
    return Number(BigInt(`0x${b.blockID}`) & 0xffffffffn);
  }

  async getNowBlock(): Promise<{ number: number; timestamp: number }> {
    const b = await this.post<{ block_header?: { raw_data?: { number?: number; timestamp?: number } } }>("/wallet/getnowblock", {});
    const raw = b.block_header?.raw_data;
    if (!raw?.timestamp) throw new TronRpcError("could not read latest block");
    return { number: raw.number ?? 0, timestamp: Math.floor(raw.timestamp / 1000) };
  }

  /** Burn price of one energy unit, in sun. */
  async getEnergyPrice(): Promise<bigint> {
    const r = await this.post<{ chainParameter?: Array<{ key: string; value?: number }> }>("/wallet/getchainparameters", {});
    const p = r.chainParameter?.find((x) => x.key === "getEnergyFee");
    return BigInt(p?.value ?? 100);
  }

  /** Network cap on a transaction's fee_limit, in sun. */
  async getMaxFeeLimit(): Promise<bigint> {
    const p = await this.getChainParameters();
    return BigInt(p.getMaxFeeLimit ?? 15_000_000_000);
  }

  async getChainParameters(): Promise<Record<string, number>> {
    const r = await this.post<{ chainParameter?: Array<{ key: string; value?: number }> }>("/wallet/getchainparameters", {});
    return Object.fromEntries((r.chainParameter ?? []).map((x) => [x.key, x.value ?? 0]));
  }

  async getTrxBalance(address: string): Promise<bigint> {
    const a = await this.post<{ balance?: number }>("/wallet/getaccount", { address: toTronHex(address) });
    return BigInt(a.balance ?? 0);
  }

  async getAccountResources(address: string) {
    const r = await this.post<Record<string, number>>("/wallet/getaccountresource", { address: toTronHex(address) });
    const energyLimit = BigInt(r.EnergyLimit ?? 0);
    const energyUsed = BigInt(r.EnergyUsed ?? 0);
    const netLimit = BigInt((r.freeNetLimit ?? 0) + (r.NetLimit ?? 0));
    const netUsed = BigInt((r.freeNetUsed ?? 0) + (r.NetUsed ?? 0));
    return {
      energyAvailable: energyLimit > energyUsed ? energyLimit - energyUsed : 0n,
      bandwidthAvailable: netLimit > netUsed ? netLimit - netUsed : 0n,
      energyLimit,
      energyUsed,
      netLimit,
      netUsed,
      /** Energy per day that 1 staked TRX currently yields, network-wide. */
      energyPerStakedTrx: r.TotalEnergyWeight ? (r.TotalEnergyLimit ?? 0) / r.TotalEnergyWeight : 0,
      /** Bandwidth per day that 1 staked TRX currently yields, network-wide. */
      bandwidthPerStakedTrx: r.TotalNetWeight ? (r.TotalNetLimit ?? 0) / r.TotalNetWeight : 0,
    };
  }

  /** The account's own Stake 2.0 balances (excludes delegations from others). */
  async getStakedBalance(address: string): Promise<{ energySun: bigint; bandwidthSun: bigint }> {
    const a = await this.post<{ frozenV2?: Array<{ type?: string; amount?: number }> }>("/wallet/getaccount", {
      address: toTronHex(address),
      visible: false,
    });
    let energySun = 0n;
    let bandwidthSun = 0n;
    for (const f of a.frozenV2 ?? []) {
      if (!f.amount) continue;
      if (f.type === "ENERGY") energySun += BigInt(f.amount);
      else if (f.type === undefined || f.type === "BANDWIDTH") bandwidthSun += BigInt(f.amount);
    }
    return { energySun, bandwidthSun };
  }

  /** True if `address` has contract code. */
  async hasCode(address: string): Promise<boolean> {
    const c = await this.post<{ bytecode?: string; runtimecode?: string }>("/wallet/getcontractinfo", {
      value: toTronHex(address),
    });
    return Boolean(c.runtimecode && c.runtimecode.length > 0);
  }

  /** Read-only call / simulation. Throws on revert with the decoded error. */
  async call(params: { from?: string; to: string; data: Hex; callValue?: bigint }): Promise<{ result: Hex; energyUsed: number }> {
    const r = await this.post<{
      result?: { result?: boolean; code?: string; message?: string };
      constant_result?: string[];
      energy_used?: number;
      transaction?: { ret?: Array<{ ret?: string }> };
    }>("/wallet/triggerconstantcontract", {
      owner_address: toTronHex(params.from ?? "0x0000000000000000000000000000000000000000"),
      contract_address: toTronHex(params.to),
      data: strip0x(params.data),
      call_value: Number(params.callValue ?? 0n),
      visible: false,
    });
    const out = (r.constant_result?.[0] ?? "") as string;
    const failed = r.result?.result !== true || r.transaction?.ret?.[0]?.ret === "FAILED";
    if (failed) {
      const reason = decodeRevert(out) ?? decodeMsg(r.result?.message) ?? "reverted";
      throw new TronRpcError(`call reverted: ${reason}`, r);
    }
    return { result: `0x${out}` as Hex, energyUsed: r.energy_used ?? 0 };
  }

  async buildTriggerTransaction(params: {
    from: string;
    to: string;
    data: Hex;
    feeLimit: bigint;
    callValue?: bigint;
  }): Promise<TronTransaction> {
    const r = await this.post<{ result?: { result?: boolean; message?: string }; transaction?: TronTransaction }>(
      "/wallet/triggersmartcontract",
      {
        owner_address: toTronHex(params.from),
        contract_address: toTronHex(params.to),
        data: strip0x(params.data),
        fee_limit: Number(params.feeLimit),
        call_value: Number(params.callValue ?? 0n),
        visible: false,
      },
    );
    if (r.result?.result !== true || !r.transaction) {
      throw new TronRpcError(`triggersmartcontract failed: ${decodeMsg(r.result?.message)}`, r);
    }
    return r.transaction;
  }

  async buildDeployTransaction(params: {
    from: string;
    bytecode: Hex;
    abi: unknown;
    name: string;
    feeLimit: bigint;
    /** Share of execution energy paid by callers; 100 = callers pay everything. */
    consumeUserResourcePercent?: number;
    originEnergyLimit?: number;
  }): Promise<TronTransaction> {
    const r = await this.post<TronTransaction & { Error?: string }>("/wallet/deploycontract", {
      owner_address: toTronHex(params.from),
      abi: JSON.stringify(params.abi),
      bytecode: strip0x(params.bytecode),
      name: params.name,
      fee_limit: Number(params.feeLimit),
      call_value: 0,
      consume_user_resource_percent: params.consumeUserResourcePercent ?? 100,
      origin_energy_limit: params.originEnergyLimit ?? 10_000_000,
      visible: false,
    });
    if (r.Error || !r.txID) throw new TronRpcError(`deploycontract failed: ${r.Error ?? "no transaction"}`, r);
    return r;
  }

  async buildTrxTransfer(params: { from: string; to: string; amount: bigint }): Promise<TronTransaction> {
    const r = await this.post<TronTransaction & { Error?: string }>("/wallet/createtransaction", {
      owner_address: toTronHex(params.from),
      to_address: toTronHex(params.to),
      amount: Number(params.amount),
      visible: false,
    });
    if (r.Error || !r.txID) throw new TronRpcError(`createtransaction failed: ${r.Error ?? "no transaction"}`, r);
    return r;
  }

  /** Builds a Stake 2.0 freeze (`/wallet/freezebalancev2`). */
  async buildFreezeBalance(params: { owner: string; amount: bigint; resource: StakeResource }): Promise<TronTransaction> {
    return this.buildSystem("/wallet/freezebalancev2", {
      owner_address: toTronHex(params.owner),
      frozen_balance: Number(params.amount),
      resource: params.resource,
      visible: false,
    });
  }

  /** Builds a Stake 2.0 unfreeze (`/wallet/unfreezebalancev2`). Funds withdraw 14 days later. */
  async buildUnfreezeBalance(params: { owner: string; amount: bigint; resource: StakeResource }): Promise<TronTransaction> {
    return this.buildSystem("/wallet/unfreezebalancev2", {
      owner_address: toTronHex(params.owner),
      unfreeze_balance: Number(params.amount),
      resource: params.resource,
      visible: false,
    });
  }

  /** Builds a withdrawal of unfrozen balances past their 14-day wait (`/wallet/withdrawexpireunfreeze`). */
  async buildWithdrawExpireUnfreeze(params: { owner: string }): Promise<TronTransaction> {
    return this.buildSystem("/wallet/withdrawexpireunfreeze", { owner_address: toTronHex(params.owner), visible: false });
  }

  private async buildSystem(path: string, body: Record<string, unknown>): Promise<TronTransaction> {
    const r = await this.post<TronTransaction & { Error?: string }>(path, body);
    if (r.Error || !r.txID) throw new TronRpcError(`${path} failed: ${decodeMsg(r.Error) ?? "no transaction"}`, r);
    return r;
  }

  async broadcast(tx: TronTransaction): Promise<string> {
    const r = await this.post<{ result?: boolean; txid?: string; code?: string; message?: string }>("/wallet/broadcasttransaction", tx);
    if (r.result !== true) throw new TronRpcError(`broadcast failed: ${r.code ?? ""} ${decodeMsg(r.message)}`.trim(), r);
    return r.txid ?? tx.txID;
  }

  async getTransactionInfo(txid: string): Promise<TransactionInfo | undefined> {
    const r = await this.post<TransactionInfo>("/wallet/gettransactioninfobyid", { value: txid });
    return r && "id" in r ? r : undefined;
  }

  /**
   * Waits until the transaction is in a block and checks execution. Broadcast
   * acceptance is not execution: a tx can be included and still revert or run
   * out of energy.
   */
  async waitForTransaction(txid: string, opts: { timeoutMs?: number; pollMs?: number } = {}): Promise<TransactionInfo> {
    const deadline = Date.now() + (opts.timeoutMs ?? 90_000);
    while (Date.now() < deadline) {
      const info = await this.getTransactionInfo(txid);
      if (info?.blockNumber !== undefined) {
        const ok = info.receipt?.result === undefined || info.receipt.result === "SUCCESS";
        if (!ok || info.result === "FAILED") {
          const reason = decodeRevert(info.contractResult?.[0]) ?? decodeMsg(info.resMessage) ?? info.receipt?.result;
          throw new TronRpcError(`transaction ${txid} failed: ${info.receipt?.result ?? ""} ${reason ?? ""}`.trim(), info);
        }
        return info;
      }
      await new Promise((r) => setTimeout(r, opts.pollMs ?? 1500));
    }
    throw new TronRpcError(`timed out waiting for ${txid}`);
  }
}

// ------------------------------------------------------------------ signing

/**
 * Signs Tron transactions. Implement at least one method:
 * - `signTransactionId`: signs the 32-byte txID (= sha256(raw_data)). Local keys, KMS/HSM.
 * - `signRawTransaction`: signs the whole transaction, so a remote signer's
 *   policy engine can parse contract, selector and arguments (e.g. an MPC
 *   wallet API with Tron transaction policies). Return the 65-byte r‖s‖v
 *   signature, or the full signed-transaction protobuf hex.
 */
export interface TronSigner {
  readonly address: TronAddress;
  signTransactionId?(txId: Hex): Promise<Hex>;
  signRawTransaction?(tx: TronTransaction): Promise<Hex | string>;
}

export function tronSignerFromPrivateKey(privateKey: Hex): TronSigner {
  const account = privateKeyToAccount(privateKey);
  return {
    address: parseTronAddress(account.address),
    signTransactionId: async (txId) => (await sign({ hash: txId, privateKey, to: "hex" })) as Hex,
  };
}

export type StakeResource = "BANDWIDTH" | "ENERGY";

export interface ExpectedCall {
  type: "TriggerSmartContract" | "CreateSmartContract" | "TransferContract" | "FreezeBalanceV2" | "UnfreezeBalanceV2" | "WithdrawExpireUnfreeze";
  from: string;
  to?: string;
  data?: Hex;
  callValue?: bigint;
  /** Transfer, freeze or unfreeze amount, in sun. */
  amount?: bigint;
  /** FreezeBalanceV2 / UnfreezeBalanceV2 resource. */
  resource?: StakeResource;
  /** Upper bound on the signed fee_limit, in sun. */
  maxFeeLimit?: bigint;
  /** CreateSmartContract: exact bytecode (with constructor args) expected in the transaction. */
  bytecode?: Hex;
  /** CreateSmartContract: expected consume_user_resource_percent. */
  consumeUserResourcePercent?: number;
  /** Longest acceptable expiration, measured from now (default 1 hour). */
  maxExpiryMs?: number;
}

const CONTRACT_TYPE: Record<ExpectedCall["type"], number> = {
  TransferContract: ContractType.TransferContract,
  CreateSmartContract: ContractType.CreateSmartContract,
  TriggerSmartContract: ContractType.TriggerSmartContract,
  FreezeBalanceV2: ContractType.FreezeBalanceV2Contract,
  UnfreezeBalanceV2: ContractType.UnfreezeBalanceV2Contract,
  WithdrawExpireUnfreeze: ContractType.WithdrawExpireUnfreezeContract,
};

/** System contracts: the node never sets a fee_limit on them. */
const SYSTEM_TYPES: ReadonlySet<ExpectedCall["type"]> = new Set(["TransferContract", "FreezeBalanceV2", "UnfreezeBalanceV2", "WithdrawExpireUnfreeze"]);

/**
 * Checks that the bytes a key would sign are exactly the intended call.
 *
 * Verification runs on the decoded `raw_data_hex` protobuf, the only thing
 * the signature commits to, never on the node's `raw_data` JSON. This closes
 * the gap where a malicious node returns honest-looking JSON next to bytes
 * for a different call. Throws a descriptive error on any mismatch.
 */
export function verifyTransaction(tx: TronTransaction, expected: ExpectedCall, now = Date.now()): DecodedTransaction {
  const id = sha256(`0x${tx.raw_data_hex}` as Hex).slice(2);
  if (id !== tx.txID?.toLowerCase()) throw new Error("txID does not match sha256(raw_data_hex)");
  let raw: DecodedTransaction;
  try {
    raw = decodeTransactionRaw(tx.raw_data_hex);
  } catch (e) {
    throw new Error(`cannot decode raw_data_hex: ${(e as Error).message}`);
  }
  if (raw.contracts.length !== 1) throw new Error("expected exactly one contract in transaction");
  const c = raw.contracts[0]!;
  if (c.type !== CONTRACT_TYPE[expected.type]) throw new Error(`unexpected contract type ${c.type}`);
  if (c.permissionId !== 0) throw new Error(`unexpected Permission_id ${c.permissionId}`);
  if (c.owner !== toTronHex(expected.from).toLowerCase()) throw new Error("transaction owner does not match signer");
  if (c.callTokenValue !== 0n || c.tokenId !== 0n) throw new Error("transaction carries a TRC-10 token transfer");
  if (raw.memo !== "") throw new Error("transaction carries an unexpected memo");
  if (raw.expiration > BigInt(now + (expected.maxExpiryMs ?? 3_600_000))) throw new Error("transaction expiration is too far in the future");
  if (raw.expiration <= BigInt(now - 60_000)) throw new Error("transaction is already expired");

  if (expected.type === "TriggerSmartContract") {
    if (c.to !== toTronHex(expected.to!).toLowerCase()) throw new Error("contract mismatch");
    if (c.data !== strip0x(expected.data ?? "0x").toLowerCase()) throw new Error("calldata mismatch");
    if (c.value !== (expected.callValue ?? 0n)) throw new Error("call value mismatch");
  }
  if (expected.type === "TransferContract") {
    if (c.to !== toTronHex(expected.to!).toLowerCase()) throw new Error("recipient mismatch");
    if (c.value !== expected.amount) throw new Error("amount mismatch");
  }
  if (expected.type === "FreezeBalanceV2" || expected.type === "UnfreezeBalanceV2") {
    if (c.value !== expected.amount) throw new Error("stake amount mismatch");
    if (c.resource !== ResourceCode[expected.resource ?? "BANDWIDTH"]) throw new Error("stake resource mismatch");
  }
  if (expected.type === "CreateSmartContract") {
    const k = c.create!;
    if (k.origin !== undefined && k.origin !== c.owner) throw new Error("origin address mismatch");
    if (k.callValue !== 0n) throw new Error("deploy carries a call value");
    if (expected.bytecode !== undefined && k.bytecode !== strip0x(expected.bytecode).toLowerCase()) throw new Error("bytecode mismatch");
    if (expected.consumeUserResourcePercent !== undefined && k.consumeUserResourcePercent !== BigInt(expected.consumeUserResourcePercent)) {
      throw new Error("consume_user_resource_percent mismatch");
    }
  }
  if (SYSTEM_TYPES.has(expected.type)) {
    if (raw.feeLimit !== 0n) throw new Error("system contract carries a fee_limit");
  } else if (expected.maxFeeLimit !== undefined && raw.feeLimit > expected.maxFeeLimit) {
    throw new Error(`fee_limit ${raw.feeLimit} exceeds ${expected.maxFeeLimit}`);
  }
  return raw;
}

/** Verifies a node-built transaction against the intended call (see {@link verifyTransaction}), then signs. */
export async function signTransaction(tx: TronTransaction, signer: TronSigner, expected: ExpectedCall): Promise<TronTransaction> {
  if (!sameSigner(signer.address, expected.from)) throw new Error("signer is not the transaction owner");
  verifyTransaction(tx, expected);
  let sig: string;
  if (signer.signRawTransaction) {
    const out = strip0x(String(await signer.signRawTransaction(tx)));
    sig = out.length === 130 ? out : extractSignature(out, tx.raw_data_hex);
  } else if (signer.signTransactionId) {
    sig = strip0x(await signer.signTransactionId(`0x${tx.txID}` as Hex));
  } else {
    throw new Error("TronSigner implements neither signTransactionId nor signRawTransaction");
  }
  if (!isHex(`0x${sig}`) || sig.length !== 130) throw new Error("signer returned an invalid signature");
  // Never broadcast a signature we have not checked: it must recover to the owner.
  const recId = Number.parseInt(sig.slice(128), 16);
  const norm = `0x${sig.slice(0, 128)}${(recId < 27 ? recId + 27 : recId).toString(16)}` as Hex;
  const recovered = await recoverAddress({ hash: `0x${tx.txID}` as Hex, signature: norm });
  if (!sameSigner(recovered, signer.address)) throw new Error("signature does not recover to the signer");
  // Broadcast the normalized form: java-tron rejects a 0/1 recovery byte, which
  // KMS/HSM signers commonly return.
  return { ...tx, signature: [strip0x(norm)] };
}

function readVarint(hex: string, pos: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  for (;;) {
    if (pos >= hex.length) throw new Error("truncated protobuf");
    const b = Number.parseInt(hex.slice(pos, pos + 2), 16);
    pos += 2;
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [result, pos];
    shift += 7n;
  }
}

/**
 * Extracts the signature from a signed Tron `Transaction` protobuf
 * (field 1 = raw_data, field 2 = signature), checking raw_data is unchanged.
 */
export function extractSignature(signedTxHex: string, expectedRawDataHex: string): string {
  const hex = strip0x(signedTxHex).toLowerCase();
  let pos = 0;
  let raw: string | undefined;
  const sigs: string[] = [];
  while (pos < hex.length) {
    const [key, p1] = readVarint(hex, pos);
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (wire === 2) {
      const [len, p2] = readVarint(hex, p1);
      const body = hex.slice(p2, p2 + Number(len) * 2);
      if (body.length !== Number(len) * 2) throw new Error("truncated protobuf field");
      if (field === 1) raw = body;
      if (field === 2) sigs.push(body);
      pos = p2 + Number(len) * 2;
    } else if (wire === 0) {
      pos = readVarint(hex, p1)[1];
    } else {
      throw new Error(`unsupported protobuf wire type ${wire}`);
    }
  }
  if (raw !== expectedRawDataHex.toLowerCase()) throw new Error("signed transaction raw_data differs from the request");
  if (sigs.length !== 1 || sigs[0]!.length !== 130) throw new Error("expected exactly one 65-byte signature");
  return sigs[0]!;
}

function sameSigner(a: string, b: string) {
  return parseTronAddress(a) === parseTronAddress(b);
}

/** Stakes TRX for energy or bandwidth (Stake 2.0): build, verify, sign, broadcast, wait. */
export async function freezeBalance(rpc: TronRpc, signer: TronSigner, amountSun: bigint, resource: StakeResource): Promise<string> {
  const tx = await rpc.buildFreezeBalance({ owner: signer.address, amount: amountSun, resource });
  const signed = await signTransaction(tx, signer, { type: "FreezeBalanceV2", from: signer.address, amount: amountSun, resource, maxExpiryMs: rpc.maxTxExpiryMs });
  const txid = await rpc.broadcast(signed);
  await rpc.waitForTransaction(txid);
  return txid;
}

/** Unstakes TRX (withdrawable after 14 days with {@link withdrawExpireUnfreeze}). */
export async function unfreezeBalance(rpc: TronRpc, signer: TronSigner, amountSun: bigint, resource: StakeResource): Promise<string> {
  const tx = await rpc.buildUnfreezeBalance({ owner: signer.address, amount: amountSun, resource });
  const signed = await signTransaction(tx, signer, { type: "UnfreezeBalanceV2", from: signer.address, amount: amountSun, resource, maxExpiryMs: rpc.maxTxExpiryMs });
  const txid = await rpc.broadcast(signed);
  await rpc.waitForTransaction(txid);
  return txid;
}

/** Withdraws every unfrozen balance whose 14-day wait has passed. */
export async function withdrawExpireUnfreeze(rpc: TronRpc, signer: TronSigner): Promise<string> {
  const tx = await rpc.buildWithdrawExpireUnfreeze({ owner: signer.address });
  const signed = await signTransaction(tx, signer, { type: "WithdrawExpireUnfreeze", from: signer.address, maxExpiryMs: rpc.maxTxExpiryMs });
  const txid = await rpc.broadcast(signed);
  await rpc.waitForTransaction(txid);
  return txid;
}

/** Sends TRX (a native TransferContract): build, verify, sign, broadcast, wait. */
export async function transferTrx(rpc: TronRpc, signer: TronSigner, to: string, amountSun: bigint): Promise<string> {
  const tx = await rpc.buildTrxTransfer({ from: signer.address, to, amount: amountSun });
  const signed = await signTransaction(tx, signer, { type: "TransferContract", from: signer.address, to, amount: amountSun, maxExpiryMs: rpc.maxTxExpiryMs });
  const txid = await rpc.broadcast(signed);
  await rpc.waitForTransaction(txid);
  return txid;
}
