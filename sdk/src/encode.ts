import { type Hex, concatHex, encodeFunctionData, encodePacked, toFunctionSelector } from "viem";
import { parseTronAddress } from "./address.js";
import { depositForwarderAbi, paymasterFactoryAbi, permitAccountAbi } from "./abi.js";
import { type Permit, assertPermit } from "./permit.js";
import type { PermitSignature } from "./sign.js";

function permitTuple(p: Permit) {
  assertPermit(p);
  return {
    token: p.token,
    owner: p.owner,
    to: p.to,
    value: p.value,
    maxFee: p.maxFee,
    relayer: p.relayer,
    deadline: p.deadline,
    nonce: p.nonce,
  };
}

export interface PermitCall {
  permit: Permit;
  signature: PermitSignature;
  relayerFee: bigint;
  /** Receives the relayer fee credit. Must equal `permit.relayer` when that is set. */
  feeRecipient: string;
}

/** Calldata for `PermitAccount.permitTransfer` (send to the account). */
export function encodePermitTransfer(c: PermitCall): Hex {
  return encodeFunctionData({
    abi: permitAccountAbi,
    functionName: "permitTransfer",
    args: [permitTuple(c.permit), c.relayerFee, parseTronAddress(c.feeRecipient), c.signature.r, c.signature.vs],
  });
}

const PACKED_SELECTOR = toFunctionSelector("permitTransferPacked()");

/**
 * Tightly packed `permitTransferPacked` calldata: 197 bytes vs 388 for the
 * ABI form — on Tron every byte is bandwidth, so this nearly halves the
 * per-transaction envelope. Same TIP-712 signature as `permitTransfer`;
 * the owner travels in the clone's code, not the calldata.
 */
export function encodePermitTransferPacked(c: PermitCall): Hex {
  const p = c.permit;
  assertPermit(p);
  const fit = (v: bigint, bits: number, what: string) => {
    if (v < 0n || v >= 1n << BigInt(bits)) throw new Error(`${what} does not fit uint${bits} (packed form)`);
    return v;
  };
  return concatHex([
    PACKED_SELECTOR,
    encodePacked(
      ["address", "address", "uint96", "uint96", "address", "uint40", "uint64", "uint96", "address", "bytes32", "bytes32"],
      [
        p.token,
        p.to,
        fit(p.value, 96, "value"),
        fit(p.maxFee, 96, "maxFee"),
        p.relayer,
        Number(fit(p.deadline, 40, "deadline")), // viem types uint40 as number (safe: < 2^53)
        fit(p.nonce, 64, "nonce"),
        fit(c.relayerFee, 96, "relayerFee"),
        parseTronAddress(c.feeRecipient),
        c.signature.r,
        c.signature.vs,
      ],
    ),
  ]);
}

/** Calldata for `PaymasterFactory.deployAndPermit` (send to the factory). */
export function encodeDeployAndPermit(c: PermitCall & { index: bigint | number }): Hex {
  return encodeFunctionData({
    abi: paymasterFactoryAbi,
    functionName: "deployAndPermit",
    args: [
      BigInt(c.index),
      permitTuple(c.permit),
      c.relayerFee,
      parseTronAddress(c.feeRecipient),
      c.signature.r,
      c.signature.vs,
    ],
  });
}

export interface SweepItem {
  treasury: string;
  sweeper?: string;
  salt: Hex;
  /** TRC-20 token; omit or zero address to sweep TRX. */
  token?: string;
}

const zero = "0x0000000000000000000000000000000000000000";

function sweepTuple(i: SweepItem) {
  return {
    treasury: parseTronAddress(i.treasury),
    sweeper: parseTronAddress(i.sweeper ?? zero),
    salt: i.salt,
    token: parseTronAddress(i.token ?? zero),
  };
}

/** `PaymasterFactory.sweep` — deploys the forwarder on first use. */
export function encodeSweep(i: SweepItem): Hex {
  const t = sweepTuple(i);
  return encodeFunctionData({ abi: paymasterFactoryAbi, functionName: "sweep", args: [t.treasury, t.sweeper, t.salt, t.token] });
}

export function encodeSweepMany(items: SweepItem[]): Hex {
  return encodeFunctionData({ abi: paymasterFactoryAbi, functionName: "sweepMany", args: [items.map(sweepTuple)] });
}

/** `DepositForwarder.sweep(token)` / `sweepTRX()` — direct call on a deployed forwarder. */
export function encodeForwarderSweep(token?: string): Hex {
  if (!token || /^0x0{40}$/i.test(parseTronAddress(token))) {
    return encodeFunctionData({ abi: depositForwarderAbi, functionName: "sweepTRX" });
  }
  return encodeFunctionData({ abi: depositForwarderAbi, functionName: "sweep", args: [parseTronAddress(token)] });
}

export function encodeDeployForwarder(i: Omit<SweepItem, "token">): Hex {
  const t = sweepTuple(i);
  return encodeFunctionData({ abi: paymasterFactoryAbi, functionName: "deployForwarder", args: [t.treasury, t.sweeper, t.salt] });
}

export function encodeDeployAccount(owner: string, index: bigint | number = 0n): Hex {
  return encodeFunctionData({ abi: paymasterFactoryAbi, functionName: "deployAccount", args: [parseTronAddress(owner), BigInt(index)] });
}

export function encodeWithdraw(token: string, to: string, amount: bigint): Hex {
  return encodeFunctionData({ abi: permitAccountAbi, functionName: "withdraw", args: [parseTronAddress(token), parseTronAddress(to), amount] });
}

export function encodeWithdrawTRX(to: string, amount: bigint): Hex {
  return encodeFunctionData({ abi: permitAccountAbi, functionName: "withdrawTRX", args: [parseTronAddress(to), amount] });
}

export function encodeSetSigner(signer: string): Hex {
  return encodeFunctionData({ abi: permitAccountAbi, functionName: "setSigner", args: [parseTronAddress(signer)] });
}

export function encodeInvalidateNonces(newNonce: bigint): Hex {
  return encodeFunctionData({ abi: permitAccountAbi, functionName: "invalidateNonces", args: [newNonce] });
}

export function encodeClaimFees(token: string, beneficiary: string, to: string): Hex {
  return encodeFunctionData({
    abi: permitAccountAbi,
    functionName: "claimFees",
    args: [parseTronAddress(token), parseTronAddress(beneficiary), parseTronAddress(to)],
  });
}

export function encodeClaimMany(accounts: string[], token: string, to: string): Hex {
  return encodeFunctionData({
    abi: paymasterFactoryAbi,
    functionName: "claimMany",
    args: [accounts.map(parseTronAddress), parseTronAddress(token), parseTronAddress(to)],
  });
}

export const Kind = { Forwarder: 0, Account: 1 } as const;
export type Kind = (typeof Kind)[keyof typeof Kind];

/** Governance calldata (send to the factory from the admin / guardian account). */
export const governance = {
  queueUpgrade: (kind: Kind, implementation: string) =>
    encodeFunctionData({ abi: paymasterFactoryAbi, functionName: "queueUpgrade", args: [kind, parseTronAddress(implementation)] }),
  cancelUpgrade: (kind: Kind) => encodeFunctionData({ abi: paymasterFactoryAbi, functionName: "cancelUpgrade", args: [kind] }),
  executeUpgrade: (kind: Kind) => encodeFunctionData({ abi: paymasterFactoryAbi, functionName: "executeUpgrade", args: [kind] }),
  queueRoles: (admin: string, guardian: string) =>
    encodeFunctionData({ abi: paymasterFactoryAbi, functionName: "queueRoles", args: [parseTronAddress(admin), parseTronAddress(guardian)] }),
  cancelRoles: () => encodeFunctionData({ abi: paymasterFactoryAbi, functionName: "cancelRoles" }),
  executeRoles: () => encodeFunctionData({ abi: paymasterFactoryAbi, functionName: "executeRoles" }),
  pause: () => encodeFunctionData({ abi: paymasterFactoryAbi, functionName: "pause" }),
  unpause: () => encodeFunctionData({ abi: paymasterFactoryAbi, functionName: "unpause" }),
  setProtocolFee: (bps: number, cap: bigint) =>
    encodeFunctionData({ abi: paymasterFactoryAbi, functionName: "setProtocolFee", args: [bps, cap] }),
};
