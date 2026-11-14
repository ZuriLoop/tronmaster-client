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
