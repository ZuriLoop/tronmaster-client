/**
 * Wallet discovery. The bug this guards against: `window.ethereum` is a single
 * slot that every injected wallet fights over, and several of them set
 * `isMetaMask: true` on purpose — so an app that reads it connects to a wallet
 * the user did not choose, under a name that is not theirs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** A window with just enough of the DOM for EIP-6963. */
function fakeWindow() {
  const target = new EventTarget();
  return Object.assign(target, {
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
  }) as unknown as Window & { ethereum?: unknown };
}

const provider = (name: string) => ({
  name,
  calls: [] as string[],
  async request({ method }: { method: string }) {
    this.calls.push(method);
    if (method === "eth_requestAccounts") return [`0x${name.length.toString().repeat(40).slice(0, 40)}`];
    return null;
  },
});

const announce = (win: Window, rdns: string, name: string, p: unknown) =>
  win.dispatchEvent(
    new CustomEvent("eip6963:announceProvider", { detail: { info: { uuid: rdns, rdns, name, icon: `data:image/svg+xml,${name}` }, provider: p } }),
  );

let wallet: typeof import("../src/wallet.js");

beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal("window", fakeWindow());
  wallet = await import("../src/wallet.js");
});
afterEach(() => vi.unstubAllGlobals());

describe("detectWallets", () => {
  it("lists every announced wallet by its own name", () => {
    announce(window, "io.metamask", "MetaMask", provider("MetaMask"));
    announce(window, "app.phantom", "Phantom", provider("Phantom"));
    expect(wallet.detectWallets()).toEqual([
      { kind: "evm", id: "io.metamask", name: "MetaMask", icon: "data:image/svg+xml,MetaMask" },
      { kind: "evm", id: "app.phantom", name: "Phantom", icon: "data:image/svg+xml,Phantom" },
    ]);
  });

  it("does not list the same wallet twice when it announces repeatedly", () => {
    const p = provider("MetaMask");
    announce(window, "io.metamask", "MetaMask", p);
    announce(window, "io.metamask", "MetaMask", p);
    expect(wallet.detectWallets()).toHaveLength(1);
  });

  it("ignores window.ethereum once a wallet has announced", () => {
    // Phantom commonly owns the slot while claiming to be MetaMask.
    (window as { ethereum?: unknown }).ethereum = { isMetaMask: true, request: async () => [] };
    announce(window, "app.phantom", "Phantom", provider("Phantom"));
    expect(wallet.detectWallets()).toEqual([{ kind: "evm", id: "app.phantom", name: "Phantom", icon: "data:image/svg+xml,Phantom" }]);
  });

  it("falls back to window.ethereum only when nothing announces", () => {
    (window as { ethereum?: unknown }).ethereum = { isMetaMask: true, request: async () => [] };
    expect(wallet.detectWallets()).toEqual([{ kind: "evm", id: "injected", name: "MetaMask" }]);
  });
});

describe("connect", () => {
  it("connects to the wallet that was chosen, not the one holding window.ethereum", async () => {
    const metamask = provider("MetaMask");
    const phantom = provider("Phantom");
    // The slot is Phantom's; the user picks MetaMask.
    (window as { ethereum?: unknown }).ethereum = phantom;
    announce(window, "io.metamask", "MetaMask", metamask);
    announce(window, "app.phantom", "Phantom", phantom);

    const c = await wallet.connect("evm", undefined, "io.metamask");
    expect(c.name).toBe("MetaMask");
    expect(c.id).toBe("io.metamask");
    expect(metamask.calls).toContain("eth_requestAccounts");
    expect(phantom.calls).toEqual([]);
  });

  it("says so plainly when the chosen wallet has gone away", async () => {
    await expect(wallet.connect("evm", undefined, "io.metamask")).rejects.toThrow(/no longer available — reload/);
  });

  it("reports the wallet is missing when there is nothing at all", async () => {
    await expect(wallet.connect("evm")).rejects.toThrow(/no EVM wallet found/);
  });
});

/**
 * A wallet with no extension to detect. On a machine with nothing installed
 * this is the only way in, so it has to survive the two places that assumed
 * exactly two kinds: `connect`, where EVM was the fallthrough rather than a
 * branch, and `onAccountChange`, where TronLink was.
 */
describe("registerWallet", () => {
  const connection = {
    kind: "embedded" as const,
    id: "passkey",
    name: "Passkey wallet",
    owner: "0x1111111111111111111111111111111111111111",
    signer: { address: "0x1111111111111111111111111111111111111111" } as never,
    canSignTronTx: false,
  };

  it("appears among the available wallets when no extension exists", () => {
    wallet.registerWallet({ kind: "embedded", id: "passkey", name: "Passkey wallet", connect: async () => connection });
    expect(wallet.detectWallets()).toEqual([{ kind: "embedded", id: "passkey", name: "Passkey wallet", icon: undefined }]);
  });

  it("is listed before the extensions, since it is the fallback that always works", () => {
    announce(window, "io.metamask", "MetaMask", provider("MetaMask"));
    wallet.registerWallet({ kind: "embedded", id: "passkey", name: "Passkey wallet", connect: async () => connection });
    expect(wallet.detectWallets().map((a) => a.id)).toEqual(["passkey", "io.metamask"]);
  });

  it("connects itself rather than falling through to the EVM path", async () => {
    let called = 0;
    const mm = provider("MetaMask");
    (window as { ethereum?: unknown }).ethereum = mm;
    wallet.registerWallet({
      kind: "embedded",
      id: "passkey",
      name: "Passkey wallet",
      connect: async () => {
        called++;
        return connection;
      },
    });
    const c = await wallet.connect("embedded", undefined, "passkey");
    expect(c.name).toBe("Passkey wallet");
    expect(called).toBe(1);
    expect(mm.calls).toEqual([]); // the browser wallet was never touched
  });

  it("does not listen for account changes on someone else's wallet", () => {
    // Its session belongs to the app, not to a page global — subscribing to
    // window events would deliver another wallet's events as if they were its.
    wallet.registerWallet({ kind: "embedded", id: "passkey", name: "Passkey wallet", connect: async () => connection });
    expect(wallet.onAccountChange("embedded", () => undefined, "passkey")()).toBeUndefined();
  });

  it("says so plainly when an unregistered kind is asked for", async () => {
    await expect(wallet.connect("embedded", undefined, "gone")).rejects.toThrow(/no embedded wallet is registered/);
  });
});

/**
 * Restoring a session is not the same as asking for one. A wallet that can
 * prompt — a passkey dialog, an extension popup — must stay quiet when the
 * page is merely reconnecting, or every page load interrupts someone who only
 * opened a tab.
 */
describe("silent reconnect", () => {
  const connection = {
    kind: "embedded" as const,
    id: "passkey",
    name: "Passkey wallet",
    owner: "0x1111111111111111111111111111111111111111",
    signer: { address: "0x1111111111111111111111111111111111111111" } as never,
    canSignTronTx: false,
  };

  it("tells the wallet when it is restoring rather than being asked", async () => {
    const seen: Array<boolean | undefined> = [];
    wallet.registerWallet({
      kind: "embedded",
      id: "passkey",
      name: "Passkey wallet",
      connect: async (opts) => {
        seen.push(opts?.silent);
        return connection;
      },
    });

    await wallet.connect("embedded", undefined, "passkey", { silent: true });
    await wallet.connect("embedded", undefined, "passkey");
    expect(seen).toEqual([true, undefined]);
  });

  it("lets a wallet refuse to reconnect without prompting", async () => {
    // No stored session and no dialog allowed: failing quietly is correct,
    // and the UI simply shows the connect screen.
    wallet.registerWallet({
      kind: "embedded",
      id: "passkey",
      name: "Passkey wallet",
      connect: async (opts) => {
        if (opts?.silent) throw new Error("no session to restore");
        return connection;
      },
    });
    await expect(wallet.connect("embedded", undefined, "passkey", { silent: true })).rejects.toThrow(/no session/);
    await expect(wallet.connect("embedded", undefined, "passkey")).resolves.toMatchObject({ name: "Passkey wallet" });
  });
});
