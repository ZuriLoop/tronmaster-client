import { type Abi, type Hex, decodeFunctionResult, encodeFunctionData } from "viem";
import { type TronAddress, ZERO_ADDRESS, parseTronAddress } from "./address.js";
import { paymasterFactoryAbi, permitAccountAbi } from "./abi.js";
import type { Deployment, TronChain } from "./chains.js";
import { getAccountSalt, getForwarderAddress, getPermitAccountAddress } from "./create2.js";
import {
  type Kind,
  type SweepItem,
  encodeClaimMany,
  encodeDeployAndPermit,
  encodeDeployForwarder,
  encodeInvalidateNonces,
  encodePermitTransfer,
  encodePermitTransferPacked,
  encodeSetSigner,
  encodeSweep,
  encodeSweepMany,
  encodeWithdraw,
  encodeWithdrawTRX,
  governance,
} from "./encode.js";
import { type Permit, buildPermit } from "./permit.js";
import { type PermitSignature, type PermitSigner, signPermit } from "./sign.js";
import { type TransactionInfo, TronRpc, type TronSigner, type TronTransaction, signTransaction } from "./tron.js";

const erc20Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

/** Reads a TRC-20's decimals and symbol (no factory needed). */
export async function getTokenInfo(rpc: TronRpc, token: string): Promise<{ decimals: number; symbol: string }> {
  const call = async (functionName: "decimals" | "symbol") => {
    const { result } = await rpc.call({ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName }) });
    return decodeFunctionResult({ abi: erc20Abi, functionName, data: result });
  };
  const [decimals, symbol] = await Promise.all([call("decimals"), call("symbol").catch(() => "?")]);
  return { decimals: Number(decimals), symbol: String(symbol) };
}

/** Reads a TRC-20 balance (no factory needed). */
export async function getTokenBalance(rpc: TronRpc, token: string, holder: string): Promise<bigint> {
  const { result } = await rpc.call({
    to: token,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [parseTronAddress(holder)] }),
  });
  return decodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", data: result });
}

const erc20TransferAbi = [
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

export interface FactoryInfo extends Deployment {
  feeToken: TronAddress;
  feeRecipient: TronAddress;
  maxBps: number;
  maxCap: bigint;
  bps: number;
  cap: bigint;
  admin: TronAddress;
  guardian: TronAddress;
  upgradeDelay: bigint;
  pauseDuration: bigint;
  paused: boolean;
  pausedUntil: bigint;
  forwarderImplementation: TronAddress;
  accountImplementation: TronAddress;
}

export interface AccountState {
  address: TronAddress;
  owner: TronAddress;
  index: bigint;
  deployed: boolean;
  nonce: bigint;
  signer: TronAddress;
}

export interface PreparedTransaction {
  txid: string;
  signed: TronTransaction;
  /** Simulated energy. */
  energyUsed: number;
  feeLimit: bigint;
}

export interface SendResult {
  txid: string;
  info: TransactionInfo;
  energyUsed: number;
}

export interface PaymasterClientOptions {
  chain: TronChain;
  /** Factory address; defaults to the chain's newest known deployment. */
  factory?: string;
  rpc?: TronRpc;
  apiKey?: string;
  /** Pays energy and signs Tron transactions (relayer, sweeper, owner, admin). */
  signer?: TronSigner;
  /** Multiplier on simulated energy for fee_limit (default 1.3). */
  feeLimitMultiplier?: number;
  /** Floor for fee_limit, in sun (default 5 TRX). */
  minFeeLimit?: bigint;
  /**
   * Called with the simulated energy before a write is built, so the caller
   * can acquire that energy first (rent, delegate, stake) instead of burning
   * TRX. Throwing aborts the write before anything is signed or paid for.
   * The CLI wires this to its energy pool; without it, writes burn as before.
   */
  ensureEnergy?: (energy: number) => Promise<void>;
}

/**
 * High-level client for one PaymasterFactory deployment.
 * Reads go through `triggerconstantcontract`; writes are simulated first, then
 * built by the node, verified, signed locally and broadcast.
 */
export class PaymasterClient {
  readonly chain: TronChain;
  readonly rpc: TronRpc;
  readonly factory: TronAddress;
  signer?: TronSigner;
  private readonly feeLimitMultiplier: number;
  private readonly ensureEnergy?: (energy: number) => Promise<void>;
  private readonly minFeeLimit: bigint;
  private deployment?: Deployment;
  private chainId?: number;

  constructor(opts: PaymasterClientOptions) {
    this.chain = opts.chain;
    this.rpc = opts.rpc ?? new TronRpc({ url: opts.chain.rpcUrl, apiKey: opts.apiKey });
    const factory = opts.factory ?? opts.chain.deployments[0]?.factory;
    if (!factory) throw new Error(`no factory configured for ${opts.chain.name}; pass { factory }`);
    this.factory = parseTronAddress(factory);
    this.signer = opts.signer;
    this.feeLimitMultiplier = opts.feeLimitMultiplier ?? 1.3;
    this.ensureEnergy = opts.ensureEnergy;
    this.minFeeLimit = opts.minFeeLimit ?? 5_000_000n;
  }

  // ------------------------------------------------------------------ reads

  async read<T>(to: string, abi: readonly unknown[], functionName: string, args: readonly unknown[] = []): Promise<T> {
    const a = abi as Abi;
    const data = encodeFunctionData({ abi: a, functionName, args } as Parameters<typeof encodeFunctionData>[0]);
    const { result } = await this.rpc.call({ to, data });
    return decodeFunctionResult({ abi: a, functionName, data: result } as Parameters<typeof decodeFunctionResult>[0]) as T;
  }

  private f<T>(fn: string, args: readonly unknown[] = []) {
    return this.read<T>(this.factory, paymasterFactoryAbi, fn, args);
  }

  async getChainId(): Promise<number> {
    if (this.chainId === undefined) this.chainId = this.chain.id || (await this.rpc.getChainId());
    return this.chainId;
  }

  /** Throws unless the factory has code — guards against wrong-network addresses. */
  async assertFactoryDeployed(): Promise<void> {
    if (!(await this.rpc.hasCode(this.factory))) {
      throw new Error(`no PaymasterFactory code at ${this.factory} on ${this.chain.name}`);
    }
  }

  /** Immutable deployment data (routers), cached after the first read. */
  async getDeployment(): Promise<Deployment> {
    if (this.deployment) return this.deployment;
    await this.assertFactoryDeployed();
    const [fr, ar] = await Promise.all([this.f<string>("FORWARDER_ROUTER"), this.f<string>("ACCOUNT_ROUTER")]);
    this.deployment = { factory: this.factory, forwarderRouter: parseTronAddress(fr), accountRouter: parseTronAddress(ar) };
    return this.deployment;
  }

  /** Full configuration and governance state, always read fresh. */
  async getFactoryInfo(): Promise<FactoryInfo> {
    const d = await this.getDeployment();
    const [feeToken, feeRecipient, maxBps, maxCap, bps, cap, admin, guardian, delay, pauseDur, pausedUntil, paused, fImpl, aImpl] =
      await Promise.all([
        this.f<string>("FEE_TOKEN"),
        this.f<string>("FEE_RECIPIENT"),
        this.f<number>("MAX_BPS"),
        this.f<bigint>("MAX_CAP"),
        this.f<number>("bps"),
        this.f<bigint>("cap"),
        this.f<string>("admin"),
        this.f<string>("guardian"),
        this.f<bigint>("UPGRADE_DELAY"),
        this.f<bigint>("PAUSE_DURATION"),
        this.f<bigint>("pausedUntil"),
        this.f<boolean>("paused"),
        this.f<string>("implementation", [0]),
        this.f<string>("implementation", [1]),
      ]);
    return {
      ...d,
      feeToken: parseTronAddress(feeToken),
      feeRecipient: parseTronAddress(feeRecipient),
      maxBps: Number(maxBps),
      maxCap,
      bps: Number(bps),
      cap,
      admin: parseTronAddress(admin),
      guardian: parseTronAddress(guardian),
      upgradeDelay: delay,
      pauseDuration: pauseDur,
      pausedUntil: BigInt(pausedUntil),
      paused,
      forwarderImplementation: parseTronAddress(fImpl),
      accountImplementation: parseTronAddress(aImpl),
    };
  }

  /** Live pause state (permits and sweeps revert while true). */
  isPaused(): Promise<boolean> {
    return this.f<boolean>("paused");
  }

  async getPendingUpgrade(kind: Kind) {
    const [implementation, eta] = await this.f<[string, bigint]>("pendingUpgrade", [kind]);
    return { implementation: parseTronAddress(implementation), eta };
  }

  async getPendingRoles() {
    const [admin, guardian, eta] = await this.f<[string, string, bigint]>("pendingRoles");
    return { admin: parseTronAddress(admin), guardian: parseTronAddress(guardian), eta };
  }

  /** Off-chain forwarder address, cross-checked against the factory's own prediction. */
  async predictForwarder(treasury: string, salt: Hex, sweeper?: string): Promise<TronAddress> {
    const { forwarderRouter } = await this.getDeployment();
    const local = getForwarderAddress({ factory: this.factory, forwarderRouter, treasury, sweeper, salt });
    const onchain = parseTronAddress(
      await this.f<string>("predictForwarder", [parseTronAddress(treasury), parseTronAddress(sweeper ?? ZERO_ADDRESS), salt]),
    );
    if (local !== onchain) throw new Error(`forwarder prediction mismatch: sdk ${local} vs factory ${onchain}`);
    return local;
  }

  async predictAccount(owner: string, index: bigint | number = 0n): Promise<TronAddress> {
    const { accountRouter } = await this.getDeployment();
    const local = getPermitAccountAddress({ factory: this.factory, accountRouter, owner, index });
    const onchain = parseTronAddress(await this.f<string>("predictAccount", [parseTronAddress(owner), BigInt(index)]));
    if (local !== onchain) throw new Error(`account prediction mismatch: sdk ${local} vs factory ${onchain}`);
    return local;
  }

  async getAccountState(owner: string, index: bigint | number = 0n): Promise<AccountState> {
    const address = await this.predictAccount(owner, index);
    const deployed = await this.rpc.hasCode(address);
    const o = parseTronAddress(owner);
    if (!deployed) return { address, owner: o, index: BigInt(index), deployed, nonce: 0n, signer: o };
    const [nonce, signer] = await Promise.all([
      this.read<bigint>(address, permitAccountAbi, "nonce"),
      this.read<string>(address, permitAccountAbi, "signer"),
    ]);
    return { address, owner: o, index: BigInt(index), deployed, nonce, signer: parseTronAddress(signer) };
  }

  async getAccountBalances(account: string, token: string) {
    const [balance, deployed] = await Promise.all([this.balanceOf(token, account), this.rpc.hasCode(account)]);
    if (!deployed) return { balance, totalOwed: 0n, protocolOwed: 0n, available: balance };
    const [totalOwed, protocolOwed, available] = await Promise.all([
      this.read<bigint>(account, permitAccountAbi, "totalOwed", [parseTronAddress(token)]),
      this.read<bigint>(account, permitAccountAbi, "protocolOwed", [parseTronAddress(token)]),
      this.read<bigint>(account, permitAccountAbi, "available", [parseTronAddress(token)]),
    ]);
    return { balance, totalOwed, protocolOwed, available };
  }

  async feeOwed(account: string, token: string, beneficiary: string): Promise<bigint> {
    if (!(await this.rpc.hasCode(account))) return 0n;
    return this.read<bigint>(account, permitAccountAbi, "feeOwed", [parseTronAddress(token), parseTronAddress(beneficiary)]);
  }

  /** Live protocol fee from the factory (governance can change bps/cap). */
  protocolFee(token: string, value: bigint): Promise<bigint> {
    return this.f<bigint>("protocolFee", [parseTronAddress(token), value]);
  }

  balanceOf(token: string, holder: string): Promise<bigint> {
    return getTokenBalance(this.rpc, token, holder);
  }

  tokenInfo(token: string): Promise<{ decimals: number; symbol: string }> {
    return getTokenInfo(this.rpc, token);
  }

  // ----------------------------------------------------------------- writes

  private requireSigner(): TronSigner {
    if (!this.signer) throw new Error("this operation needs a signer (PaymasterClientOptions.signer)");
    return this.signer;
  }

  /**
   * Simulates, builds, verifies and signs without broadcasting. The txid is
   * final at this point, so callers can persist it before broadcasting.
   */
  async prepare(to: string, data: Hex, opts: { feeLimit?: bigint; callValue?: bigint } = {}): Promise<PreparedTransaction> {
    const signer = this.requireSigner();
    const sim = await this.rpc.call({ from: signer.address, to, data, callValue: opts.callValue });
    // Acquire the energy before building: the fee_limit below is still sized
    // at the burn price on purpose, because an undersized limit makes rented
    // or delegated energy silently unusable (OUT_OF_ENERGY).
    if (this.ensureEnergy) await this.ensureEnergy(Math.ceil(sim.energyUsed * 1.05));
    let feeLimit = opts.feeLimit;
    if (feeLimit === undefined) {
      const price = await this.rpc.getEnergyPrice();
      feeLimit = (BigInt(Math.ceil(sim.energyUsed * this.feeLimitMultiplier)) + 1n) * price;
      if (feeLimit < this.minFeeLimit) feeLimit = this.minFeeLimit;
    }
    const maxFeeLimit = await this.rpc.getMaxFeeLimit();
    if (feeLimit > maxFeeLimit) {
      if (opts.feeLimit === undefined && maxFeeLimit < BigInt(sim.energyUsed) * (await this.rpc.getEnergyPrice())) {
        throw new Error(`simulated cost exceeds the network's max fee_limit (${maxFeeLimit} sun); stake or rent energy`);
      }
      feeLimit = maxFeeLimit;
    }
    const tx = await this.rpc.buildTriggerTransaction({ from: signer.address, to, data, feeLimit, callValue: opts.callValue });
    const signed = await signTransaction(tx, signer, { type: "TriggerSmartContract", from: signer.address, to, data, callValue: opts.callValue, maxFeeLimit: feeLimit, maxExpiryMs: this.rpc.maxTxExpiryMs });
    return { txid: signed.txID, signed, energyUsed: sim.energyUsed, feeLimit };
  }

  /** Simulates, builds, verifies, signs, broadcasts and waits. */
  async send(to: string, data: Hex, opts: { feeLimit?: bigint; callValue?: bigint; wait?: boolean } = {}): Promise<SendResult> {
    const p = await this.prepare(to, data, opts);
    const txid = await this.rpc.broadcast(p.signed);
    const info = opts.wait === false ? ({ id: txid } as TransactionInfo) : await this.rpc.waitForTransaction(txid);
    return { txid, info, energyUsed: p.energyUsed };
  }

  /** Plain TRC-20 transfer from the signer (e.g. funding a deposit address). */
  transferToken(token: string, to: string, amount: bigint) {
    const data = encodeFunctionData({ abi: erc20TransferAbi, functionName: "transfer", args: [parseTronAddress(to), amount] });
    return this.send(token, data);
  }

  // custodial

  deployForwarder(item: Omit<SweepItem, "token">) {
    return this.send(this.factory, encodeDeployForwarder(item));
  }

  /** Sweeps one forwarder (deploying it on first use). The caller must be the sweeper when one is set. */
  sweep(item: SweepItem) {
    return this.send(this.factory, encodeSweep(item));
  }

  sweepMany(items: SweepItem[]) {
    return this.send(this.factory, encodeSweepMany(items));
  }

  // permit mode

  /**
   * Builds a permit with the account's current nonce and the protocol fee
   * folded into `maxFee`. Sign it with {@link signPermit}.
   */
  async preparePermit(p: {
    owner: string;
    index?: bigint | number;
    token: string;
    to: string;
    value: bigint;
    relayerFee: bigint;
    relayer?: string;
    ttlSeconds?: number;
    /** Extra headroom on maxFee, in bps of the fees (default 0). */
    feeBufferBps?: number;
  }): Promise<{ permit: Permit; account: TronAddress; protocolFee: bigint; chainId: number; signer: TronAddress }> {
    const state = await this.getAccountState(p.owner, p.index);
    const protocolFee = await this.protocolFee(p.token, p.value);
    const base = p.relayerFee + protocolFee;
    const maxFee = base + (base * BigInt(p.feeBufferBps ?? 0)) / 10_000n;
    const now = (await this.rpc.getNowBlock()).timestamp;
    const permit = buildPermit({
      token: p.token,
      owner: p.owner,
      to: p.to,
      value: p.value,
      maxFee,
      relayer: p.relayer,
      nonce: state.nonce,
      ttlSeconds: p.ttlSeconds,
      now,
    });
    return { permit, account: state.address, protocolFee, chainId: await this.getChainId(), signer: state.signer };
  }

  async signPermit(signer: PermitSigner, permit: Permit, account: string, expectedSigner?: string): Promise<PermitSignature> {
    return signPermit(signer, permit, { account, chainId: await this.getChainId() }, { expectedSigner });
  }

  /**
   * Submits a signed permit from this client's signer (self-relay or a relayer).
   * Uses `deployAndPermit` when the account has no code yet.
   */
  async submitPermit(p: {
    permit: Permit;
    signature: PermitSignature;
    index?: bigint | number;
    relayerFee: bigint;
    feeRecipient?: string;
  }): Promise<SendResult & { account: TronAddress }> {
    const signer = this.requireSigner();
    const index = BigInt(p.index ?? 0);
    const account = await this.predictAccount(p.permit.owner, index);
    const feeRecipient = p.feeRecipient ?? (p.permit.relayer !== ZERO_ADDRESS ? p.permit.relayer : signer.address);
    const call = { permit: p.permit, signature: p.signature, relayerFee: p.relayerFee, feeRecipient };
    const deployed = await this.rpc.hasCode(account);
    const res = deployed
      ? await this.send(account, encodePermitTransferPacked(call))
      : await this.send(this.factory, encodeDeployAndPermit({ ...call, index }));
    return { ...res, account };
  }

  /** Owner exit. The client's signer must be the account owner. */
  async withdraw(p: { index?: bigint | number; token?: string; to: string; amount: bigint }) {
    const signer = this.requireSigner();
    const account = await this.predictAccount(signer.address, p.index ?? 0n);
    const data = p.token ? encodeWithdraw(p.token, p.to, p.amount) : encodeWithdrawTRX(p.to, p.amount);
    return this.send(account, data);
  }

  async setSigner(p: { index?: bigint | number; signer: string }) {
    const account = await this.predictAccount(this.requireSigner().address, p.index ?? 0n);
    return this.send(account, encodeSetSigner(p.signer));
  }

  async invalidateNonces(p: { index?: bigint | number; newNonce: bigint }) {
    const account = await this.predictAccount(this.requireSigner().address, p.index ?? 0n);
    return this.send(account, encodeInvalidateNonces(p.newNonce));
  }

  /** Claims the signer's accrued fees from many accounts in one transaction. */
  claimMany(p: { accounts: string[]; token: string; to?: string }) {
    return this.send(this.factory, encodeClaimMany(p.accounts, p.token, p.to ?? this.requireSigner().address));
  }

  // governance (signer = admin or guardian)

  readonly gov = {
    queueUpgrade: (kind: Kind, implementation: string) => this.send(this.factory, governance.queueUpgrade(kind, implementation)),
    cancelUpgrade: (kind: Kind) => this.send(this.factory, governance.cancelUpgrade(kind)),
    executeUpgrade: (kind: Kind) => this.send(this.factory, governance.executeUpgrade(kind)),
    queueRoles: (admin: string, guardian: string) => this.send(this.factory, governance.queueRoles(admin, guardian)),
    cancelRoles: () => this.send(this.factory, governance.cancelRoles()),
    executeRoles: () => this.send(this.factory, governance.executeRoles()),
    pause: () => this.send(this.factory, governance.pause()),
    unpause: () => this.send(this.factory, governance.unpause()),
    setProtocolFee: (bps: number, cap: bigint) => this.send(this.factory, governance.setProtocolFee(bps, cap)),
  };
}

export function createPaymasterClient(opts: PaymasterClientOptions): PaymasterClient {
  return new PaymasterClient(opts);
}

/** @internal re-export for salt helpers */
export { getAccountSalt };
