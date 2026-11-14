/**
 * Adding Tron to an EVM wallet.
 *
 * MetaMask will not sign typed data whose `domain.chainId` differs from the
 * active chain, so a wallet that cannot add the network cannot sign a permit
 * at all. That makes `wallet_addEthereumChain` load-bearing, and its
 * validation rules are MetaMask's, not ours.
 */
import { describe, expect, it } from "vitest";
import { TRON_EVM_NETWORKS, ensureTronNetwork, fromEip1193 } from "../src/sign.js";

type Call = { method: string; params?: unknown[] };

/**
 * A wallet on `chainId`, which rejects a switch to any chain it was not told
 * about. `switchError` replaces that rejection, to stand in for the other
 * answers a real wallet gives a site it has not granted the chain to.
 */
function wallet(opts: { chainId?: number; known?: number[]; switchError?: { message: string; code?: number } } = {}) {
  const calls: Call[] = [];
  const known = new Set(opts.known ?? []);
  let active = opts.chainId;
  return {
    calls,
    async request(args: Call) {
      calls.push(args);
      if (args.method === "eth_chainId") {
        return active === undefined ? undefined : `0x${active.toString(16)}`;
      }
      if (args.method === "wallet_switchEthereumChain") {
        const id = Number.parseInt((args.params?.[0] as { chainId: string }).chainId, 16);
        if (known.has(id)) {
          active = id;
          return null;
        }
        if (opts.switchError) throw Object.assign(new Error(opts.switchError.message), { code: opts.switchError.code });
        throw Object.assign(new Error("Unrecognized chain ID"), { code: 4902 });
      }
      if (args.method === "wallet_addEthereumChain") {
        const p = args.params?.[0] as { nativeCurrency?: { decimals?: number } };
        // MetaMask's own rule, verbatim in behaviour: anything but 18 is refused.
        if (p.nativeCurrency && p.nativeCurrency.decimals !== 18) {
          throw new Error(`Expected the number 18 for 'nativeCurrency.decimals' when 'nativeCurrency' is provided. Received: ${p.nativeCurrency.decimals}`);
        }
        const id = Number.parseInt((args.params?.[0] as { chainId: string }).chainId, 16);
        known.add(id);
        active = id;
        return null;
      }
      throw new Error(`unexpected ${args.method}`);
    },
  };
}

const nile = TRON_EVM_NETWORKS.nile!;

describe("ensureTronNetwork", () => {
  it("adds the network with decimals MetaMask accepts", async () => {
    // TRX has 6 decimals; MetaMask takes only 18 here. 6 fails the add, and a
    // failed add means no signature and no transfer.
    const w = wallet();
    await expect(ensureTronNetwork(w, nile)).resolves.toBeUndefined();
    const add = w.calls.find((c) => c.method === "wallet_addEthereumChain");
    expect((add?.params?.[0] as { nativeCurrency: unknown }).nativeCurrency).toEqual({ name: "TRX", symbol: "TRX", decimals: 18 });
  });

  it("does nothing when the wallet is already on the chain", async () => {
    const w = wallet({ chainId: nile.chainId });
    await ensureTronNetwork(w, nile);
    expect(w.calls.map((c) => c.method)).toEqual(["eth_chainId"]);
  });

  it("switches without adding when the wallet already knows the chain", async () => {
    const w = wallet({ chainId: 1, known: [nile.chainId] });
    await ensureTronNetwork(w, nile);
    expect(w.calls.map((c) => c.method)).toEqual(["eth_chainId", "wallet_switchEthereumChain"]);
  });

  it("asks to add the chain when the wallet says the site is not authorized for it", async () => {
    // MetaMask answers 4100 for a chain the site was never granted, which is
    // indistinguishable from a hard failure by code. Rethrowing it stranded
    // the user on "The requested account and/or method has not been
    // authorized by the user" with no prompt and nothing to click.
    const w = wallet({ chainId: 1, switchError: { message: "The requested account and/or method has not been authorized by the user.", code: 4100 } });
    await expect(ensureTronNetwork(w, nile)).resolves.toBeUndefined();
    expect(w.calls.map((c) => c.method)).toContain("wallet_addEthereumChain");
  });

  it("does not ask twice when the user has already said no", async () => {
    const w = wallet({ chainId: 1, switchError: { message: "User rejected the request.", code: 4001 } });
    await expect(ensureTronNetwork(w, nile)).rejects.toThrow(/User rejected/);
    expect(w.calls.map((c) => c.method)).not.toContain("wallet_addEthereumChain");
  });

  it("switches again if adding the chain left the wallet where it was", async () => {
    const w = wallet({ chainId: 1 });
    // The stub switches on add, so a second switch must not be needed.
    await ensureTronNetwork(w, nile);
    expect(w.calls.filter((c) => c.method === "wallet_switchEthereumChain")).toHaveLength(1);
  });

  it("sends the chain id as hex, which is what the wallet compares", async () => {
    const w = wallet({ chainId: 1 });
    await ensureTronNetwork(w, nile);
    for (const c of w.calls.filter((c) => c.method !== "eth_chainId")) {
      expect((c.params?.[0] as { chainId: string }).chainId).toBe("0xcd8690dc");
    }
    expect(Number.parseInt("0xcd8690dc", 16)).toBe(3448148188);
  });
});

/** The account a site may sign for is a permission, not whatever is on screen. */
describe("fromEip1193 authorization", () => {
  const ACCOUNT = "0x0d5bbf4c550a4d7248b47906091f88150000bcce";
  const SIG = `0x${"ab".repeat(65)}`;
  const td = { domain: {}, types: { PermitTransfer: [] }, primaryType: "PermitTransfer", message: {} } as never;

  function signer(opts: { permitted: string[]; granted?: string[] }) {
    const calls: string[] = [];
    const provider = {
      async request({ method }: Call) {
        calls.push(method);
        if (method === "eth_accounts") return opts.permitted;
        if (method === "eth_requestAccounts") return opts.granted ?? opts.permitted;
        if (method === "eth_signTypedData_v4") return SIG;
        throw new Error(`unexpected ${method}`);
      },
    };
    return { calls, s: fromEip1193(provider, ACCOUNT) };
  }

  it("signs without prompting when the account is already permitted", async () => {
    const { calls, s } = signer({ permitted: [ACCOUNT] });
    expect(await s.signTypedData!(td)).toBe(SIG);
    expect(calls).toEqual(["eth_accounts", "eth_signTypedData_v4"]);
  });

  it("matches the permitted account regardless of case", async () => {
    // Wallets hand back checksummed addresses; ours are lowercase Tron hex.
    const { s } = signer({ permitted: ["0x0D5BBF4C550A4D7248B47906091F88150000BCCE"] });
    expect(await s.signTypedData!(td)).toBe(SIG);
  });

  it("asks for the account instead of failing when it is not permitted yet", async () => {
    const { calls, s } = signer({ permitted: [], granted: [ACCOUNT] });
    expect(await s.signTypedData!(td)).toBe(SIG);
    expect(calls).toEqual(["eth_accounts", "eth_requestAccounts", "eth_signTypedData_v4"]);
  });

  it("names the account the wallet will not sign for, and never asks it to", async () => {
    // The wallet is connected — to someone else. 4100 on its own says only
    // "not been authorized by the user", which reads like a chain problem.
    const { calls, s } = signer({ permitted: ["0x1111111111111111111111111111111111111111"], granted: [] });
    await expect(s.signTypedData!(td)).rejects.toThrow(/has not connected 0x0d5bbf4c550a4d7248b47906091f88150000bcce to this site/);
    expect(calls).not.toContain("eth_signTypedData_v4");
  });
});

/**
 * MetaMask scopes the accounts permission per chain. A network added while
 * the site is already connected lands outside the scope granted at connect
 * time, so signing fails 4100 while eth_accounts still lists the account —
 * nothing visible says the chain is what is missing.
 */
describe("fromEip1193 on a chain added after connecting", () => {
  const ACCOUNT = "0x0d5bbf4c550a4d7248b47906091f88150000bcce";
  const SIG = `0x${"cd".repeat(65)}`;
  const td = { domain: {}, types: { PermitTransfer: [] }, primaryType: "PermitTransfer", message: {} } as never;

  function wallet(opts: { grantOnRequest: boolean }) {
    const calls: string[] = [];
    let scoped = false;
    return {
      calls,
      provider: {
        async request({ method }: Call) {
          calls.push(method);
          if (method === "eth_chainId") return `0x${nile.chainId.toString(16)}`; // already on it: the chain was added earlier
          if (method === "eth_accounts") return [ACCOUNT]; // connected the whole time
          if (method === "wallet_requestPermissions") {
            scoped = opts.grantOnRequest;
            return [{ parentCapability: "eth_accounts" }];
          }
          if (method === "eth_signTypedData_v4") {
            if (!scoped) throw Object.assign(new Error("The requested account and/or method has not been authorized by the user."), { code: 4100 });
            return SIG;
          }
          throw new Error(`unexpected ${method}`);
        },
      },
    };
  }

  it("re-requests the permission and signs, instead of surfacing 4100", async () => {
    const w = wallet({ grantOnRequest: true });
    expect(await fromEip1193(w.provider, ACCOUNT).signTypedData!(td)).toBe(SIG);
    expect(w.calls).toEqual(["eth_accounts", "eth_signTypedData_v4", "wallet_requestPermissions", "eth_signTypedData_v4"]);
  });

  it("asks once, then says what the user has to do", async () => {
    const w = wallet({ grantOnRequest: false });
    await expect(fromEip1193(w.provider, ACCOUNT, nile).signTypedData!(td)).rejects.toThrow(
      /will not sign for 0x0d5b.* on Tron Nile testnet .* connect this site while that network is selected/,
    );
    expect(w.calls.filter((c) => c === "wallet_requestPermissions")).toHaveLength(1);
  });
});
