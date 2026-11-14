import type { Hex } from "viem";

/**
 * Minimal decoder for the Tron `Transaction.raw` protobuf (the bytes that
 * `txID = sha256(raw_data_hex)` commits to and that a key actually signs).
 *
 * The node returns both `raw_data` (JSON) and `raw_data_hex`. Only the hex is
 * signed, and nothing forces the two to agree, so verification must run on
 * the decoded bytes. Field numbers follow java-tron's `Tron.proto` and
 * `smart_contract.proto` / `balance_contract.proto`.
 */

export class TxDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TxDecodeError";
  }
}

type Value = { wire: 0; v: bigint } | { wire: 2; v: Uint8Array } | { wire: 1 | 5; v: Uint8Array };
type Message = Map<number, Value[]>;

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(h)) throw new TxDecodeError("raw_data_hex is not valid hex");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const toHexStr = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

function readVarint(buf: Uint8Array, pos: number): [bigint, number] {
  let r = 0n;
  let shift = 0n;
  for (let i = 0; i < 10; i++) {
    if (pos >= buf.length) throw new TxDecodeError("truncated varint");
    const b = buf[pos++]!;
    r |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [r, pos];
    shift += 7n;
  }
  throw new TxDecodeError("varint too long");
}

function parse(buf: Uint8Array): Message {
  const out: Message = new Map();
  let pos = 0;
  while (pos < buf.length) {
    const [key, p1] = readVarint(buf, pos);
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (field === 0) throw new TxDecodeError("field number 0");
    let val: Value;
    if (wire === 0) {
      const [v, p2] = readVarint(buf, p1);
      val = { wire: 0, v };
      pos = p2;
    } else if (wire === 2) {
      const [len, p2] = readVarint(buf, p1);
      const end = p2 + Number(len);
      if (len > BigInt(buf.length) || end > buf.length) throw new TxDecodeError("truncated field");
      val = { wire: 2, v: buf.subarray(p2, end) };
      pos = end;
    } else if (wire === 1 || wire === 5) {
      const n = wire === 1 ? 8 : 4;
      if (p1 + n > buf.length) throw new TxDecodeError("truncated fixed field");
      val = { wire, v: buf.subarray(p1, p1 + n) };
      pos = p1 + n;
    } else {
      throw new TxDecodeError(`unsupported wire type ${wire}`);
    }
    const list = out.get(field);
    if (list) list.push(val);
    else out.set(field, [val]);
  }
  return out;
}

function single(m: Message, field: number, what: string): Value | undefined {
  const l = m.get(field);
  if (!l) return undefined;
  if (l.length !== 1) throw new TxDecodeError(`${what} appears ${l.length} times`);
  return l[0];
}
function bytesField(m: Message, field: number, what: string): Uint8Array | undefined {
  const v = single(m, field, what);
  if (!v) return undefined;
  if (v.wire !== 2) throw new TxDecodeError(`${what} has wire type ${v.wire}`);
  return v.v;
}
function intField(m: Message, field: number, what: string): bigint {
  const v = single(m, field, what);
  if (!v) return 0n;
  if (v.wire !== 0) throw new TxDecodeError(`${what} has wire type ${v.wire}`);
  return v.v;
}
function onlyFields(m: Message, allowed: number[], what: string) {
  for (const f of m.keys()) if (!allowed.includes(f)) throw new TxDecodeError(`${what} has unexpected field ${f}`);
}
const addr = (b: Uint8Array | undefined, what: string): string | undefined => {
  if (!b) return undefined;
  if (b.length !== 21 || b[0] !== 0x41) throw new TxDecodeError(`${what} is not a 21-byte 0x41 address`);
  return toHexStr(b);
};

/** java-tron ContractType values handled here. */
export const ContractType = {
  TransferContract: 1,
  CreateSmartContract: 30,
  TriggerSmartContract: 31,
  FreezeBalanceV2Contract: 54,
  UnfreezeBalanceV2Contract: 55,
  WithdrawExpireUnfreezeContract: 56,
} as const;

/** Stake 2.0 resource codes. */
export const ResourceCode = { BANDWIDTH: 0, ENERGY: 1 } as const;

export interface DecodedContract {
  type: number;
  typeUrl: string;
  permissionId: number;
  /** 41-prefixed hex, lowercase. */
  owner: string;
  /** TriggerSmartContract: target. TransferContract: recipient. */
  to?: string;
  /** TriggerSmartContract calldata, lowercase hex without 0x. */
  data?: string;
  /** call_value / transfer amount / staked or unstaked amount, in sun. */
  value: bigint;
  /** Freeze/Unfreeze: 0 = BANDWIDTH, 1 = ENERGY. */
  resource?: number;
  callTokenValue: bigint;
  tokenId: bigint;
  /** CreateSmartContract fields. */
  create?: {
    origin?: string;
    bytecode: string;
    callValue: bigint;
    consumeUserResourcePercent: bigint;
    originEnergyLimit: bigint;
    name: string;
  };
}

export interface DecodedTransaction {
  refBlockBytes: string;
  refBlockHash: string;
  expiration: bigint;
  timestamp: bigint;
  feeLimit: bigint;
  /** Memo (`raw.data`), hex. */
  memo: string;
  contracts: DecodedContract[];
}

// Transaction.raw
const RAW = { refBlockBytes: 1, refBlockNum: 3, refBlockHash: 4, expiration: 8, auths: 9, data: 10, contract: 11, scripts: 12, timestamp: 14, feeLimit: 18 };

/** Decodes `raw_data_hex`. Throws on malformed or unexpected structure. */
export function decodeTransactionRaw(rawDataHex: string | Hex): DecodedTransaction {
  const raw = parse(hexToBytes(rawDataHex));
  onlyFields(raw, Object.values(RAW), "Transaction.raw");
  if (raw.has(RAW.auths)) throw new TxDecodeError("transaction carries auths");
  if (raw.has(RAW.scripts)) throw new TxDecodeError("transaction carries scripts");
  const contracts = (raw.get(RAW.contract) ?? []).map((c) => {
    if (c.wire !== 2) throw new TxDecodeError("contract is not a message");
    return decodeContract(c.v);
  });
  return {
    refBlockBytes: toHexStr(bytesField(raw, RAW.refBlockBytes, "ref_block_bytes") ?? new Uint8Array()),
    refBlockHash: toHexStr(bytesField(raw, RAW.refBlockHash, "ref_block_hash") ?? new Uint8Array()),
    expiration: intField(raw, RAW.expiration, "expiration"),
    timestamp: intField(raw, RAW.timestamp, "timestamp"),
    feeLimit: intField(raw, RAW.feeLimit, "fee_limit"),
    memo: toHexStr(bytesField(raw, RAW.data, "data") ?? new Uint8Array()),
    contracts,
  };
}

function decodeContract(buf: Uint8Array): DecodedContract {
  // Transaction.Contract { type=1; parameter=2 (Any); provider=3; ContractName=4; Permission_id=5 }
  const c = parse(buf);
  onlyFields(c, [1, 2, 3, 4, 5], "Transaction.Contract");
  const type = Number(intField(c, 1, "contract type"));
  const anyBuf = bytesField(c, 2, "contract parameter");
  if (!anyBuf) throw new TxDecodeError("contract has no parameter");
  const any = parse(anyBuf);
  onlyFields(any, [1, 2], "google.protobuf.Any");
  const typeUrl = new TextDecoder().decode(bytesField(any, 1, "type_url") ?? new Uint8Array());
  const value = parse(bytesField(any, 2, "Any.value") ?? new Uint8Array());
  const permissionId = Number(intField(c, 5, "Permission_id"));
  const base = { type, typeUrl, permissionId, value: 0n, callTokenValue: 0n, tokenId: 0n };

  if (type === ContractType.TriggerSmartContract) {
    // owner_address=1 contract_address=2 call_value=3 data=4 call_token_value=5 token_id=6
    expectUrl(typeUrl, "protocol.TriggerSmartContract");
    onlyFields(value, [1, 2, 3, 4, 5, 6], "TriggerSmartContract");
    return {
      ...base,
      owner: req(addr(bytesField(value, 1, "owner_address"), "owner_address"), "owner_address"),
      to: req(addr(bytesField(value, 2, "contract_address"), "contract_address"), "contract_address"),
      value: intField(value, 3, "call_value"),
      data: toHexStr(bytesField(value, 4, "data") ?? new Uint8Array()),
      callTokenValue: intField(value, 5, "call_token_value"),
      tokenId: intField(value, 6, "token_id"),
    };
  }
  if (type === ContractType.TransferContract) {
    // owner_address=1 to_address=2 amount=3
    expectUrl(typeUrl, "protocol.TransferContract");
    onlyFields(value, [1, 2, 3], "TransferContract");
    return {
      ...base,
      owner: req(addr(bytesField(value, 1, "owner_address"), "owner_address"), "owner_address"),
      to: req(addr(bytesField(value, 2, "to_address"), "to_address"), "to_address"),
      value: intField(value, 3, "amount"),
    };
  }
  if (type === ContractType.FreezeBalanceV2Contract || type === ContractType.UnfreezeBalanceV2Contract) {
    // owner_address=1 frozen_balance|unfreeze_balance=2 resource=3
    expectUrl(typeUrl, type === ContractType.FreezeBalanceV2Contract ? "protocol.FreezeBalanceV2Contract" : "protocol.UnfreezeBalanceV2Contract");
    onlyFields(value, [1, 2, 3], "FreezeBalanceV2/UnfreezeBalanceV2");
    const resource = Number(intField(value, 3, "resource"));
    if (resource !== ResourceCode.BANDWIDTH && resource !== ResourceCode.ENERGY) throw new TxDecodeError(`unknown resource ${resource}`);
    return {
      ...base,
      owner: req(addr(bytesField(value, 1, "owner_address"), "owner_address"), "owner_address"),
      value: intField(value, 2, "amount"),
      resource,
    };
  }
  if (type === ContractType.WithdrawExpireUnfreezeContract) {
    // owner_address=1
    expectUrl(typeUrl, "protocol.WithdrawExpireUnfreezeContract");
    onlyFields(value, [1], "WithdrawExpireUnfreeze");
    return { ...base, owner: req(addr(bytesField(value, 1, "owner_address"), "owner_address"), "owner_address") };
  }
  if (type === ContractType.CreateSmartContract) {
    // owner_address=1 new_contract=2 call_token_value=3 token_id=4
    expectUrl(typeUrl, "protocol.CreateSmartContract");
    onlyFields(value, [1, 2, 3, 4], "CreateSmartContract");
    // SmartContract: origin_address=1 contract_address=2 abi=3 bytecode=4 call_value=5
    // consume_user_resource_percent=6 name=7 origin_energy_limit=8 code_hash=9 trx_hash=10 version=11
    const sc = parse(bytesField(value, 2, "new_contract") ?? new Uint8Array());
    onlyFields(sc, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], "SmartContract");
    return {
      ...base,
      owner: req(addr(bytesField(value, 1, "owner_address"), "owner_address"), "owner_address"),
      callTokenValue: intField(value, 3, "call_token_value"),
      tokenId: intField(value, 4, "token_id"),
      create: {
        origin: addr(bytesField(sc, 1, "origin_address"), "origin_address"),
        bytecode: toHexStr(bytesField(sc, 4, "bytecode") ?? new Uint8Array()),
        callValue: intField(sc, 5, "call_value"),
        consumeUserResourcePercent: intField(sc, 6, "consume_user_resource_percent"),
        originEnergyLimit: intField(sc, 8, "origin_energy_limit"),
        name: new TextDecoder().decode(bytesField(sc, 7, "name") ?? new Uint8Array()),
      },
    };
  }
  throw new TxDecodeError(`unsupported contract type ${type}`);
}

function expectUrl(got: string, want: string) {
  if (got !== `type.googleapis.com/${want}`) throw new TxDecodeError(`type_url ${got} does not match ${want}`);
}
function req<T>(v: T | undefined, what: string): T {
  if (v === undefined) throw new TxDecodeError(`missing ${what}`);
  return v;
}
