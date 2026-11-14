import { createRelayerClient, fromEip1193, parseTronAddress, signPermit, toBase58 } from "@tron-paymaster/sdk";
import { type Hex, keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { USDT_DECIMALS, chain, client, factory, usdt } from "../src/config.js";

/**
 * Exercises the app's own configuration and signing path against live Nile,
 * using a stub EIP-1193 wallet (the same shape MetaMask presents) so the
 * whole user journey is covered without a browser.
 *
 *   APP_LIVE=1 APP_RELAYER=http://127.0.0.1:8787 APP_OWNER_KEY=0x… pnpm --filter @tron-paymaster/app test
 *
 * Without APP_RELAYER it still checks the read-only half: config resolves and
 * a real account is derived and read from the chain.
 */
const live = process.env.APP_LIVE === "1" ? describe : describe.skip;

live("app against live Nile", () => {
  it("config points at a real, deployed factory", async () => {
    expect(chain.name).toBe("nile");
    await expect(client.assertFactoryDeployed()).resolves.not.toThrow();
    expect(toBase58(factory)).toMatch(/^T[1-9A-HJ-NP-Za-km-z]{33}$/);
  });

  it("derives a usable account address for an arbitrary key, before it exists on-chain", async () => {
    const owner = privateKeyToAccount(keccak256(toHex(`app-live-${Date.now()}`))).address;
    const state = await client.getAccountState(owner);
    expect(toBase58(state.address)).toMatch(/^T/);
    expect(state.deployed).toBe(false);
    expect(state.nonce).toBe(0n);
    // A brand-new account reads cleanly rather than throwing: the receive
    // screen must work before any contract is deployed.
    expect(await client.balanceOf(usdt, state.address)).toBe(0n);
  });

  it("completes a transfer through a wallet-shaped signer", async () => {
    const relayerUrl = process.env.APP_RELAYER;
    const key = process.env.APP_OWNER_KEY as Hex | undefined;
    if (!relayerUrl || !key) return; // read-only run

    // The SDK sends deployed accounts the packed entrypoint, which only exists
    // post-energy-diet. Against an older factory every permit reverts, so say
    // that plainly rather than failing as if the app were broken.
    const impl = (await client.getFactoryInfo()).accountImplementation;
    const postDiet = await client
      .read(impl, [{ type: "function", name: "FEE_TOKEN", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" }], "FEE_TOKEN")
      .then(() => true)
      .catch(() => false);
    if (!postDiet) {
      console.warn(`skipping: factory ${toBase58(factory)} predates the energy diet — redeploy it before running this`);
      return;
    }

    const account = privateKeyToAccount(key);
    const owner = account.address;
    // A stub EIP-1193 provider: exactly what fromEip1193 talks to in a browser.
    const provider = {
      async request(args: { method: string; params?: unknown[] }) {
        if (args.method === "eth_requestAccounts") return [owner];
        if (args.method !== "eth_signTypedData_v4") throw new Error(`unexpected ${args.method}`);
        const td = JSON.parse((args.params as [string, string])[1]);
        return account.signTypedData({ domain: { ...td.domain, chainId: Number(td.domain.chainId) }, types: td.types, primaryType: td.primaryType, message: td.message });
      },
    };

    const state = await client.getAccountState(owner);
    const balance = await client.balanceOf(usdt, state.address);
    expect(balance, `fund ${toBase58(state.address)} with Nile USDT first`).toBeGreaterThan(0n);

    // Defaults to the owner's own key, so the 0.1 USDT comes back to an
    // address the person running this controls. Set TPM_TEST_RECIPIENT to
    // send somewhere else; never leave a stranger's address as a default.
    const recipient = parseTronAddress(process.env.TPM_TEST_RECIPIENT ?? owner);
    const relayer = createRelayerClient({ url: relayerUrl });
    const value = 10n ** BigInt(USDT_DECIMALS) / 10n; // 0.1 USDT

    const q = await relayer.quote({ owner, token: usdt, to: recipient, value });
    expect(q.account).toBe(state.address);
    expect(BigInt(q.nonce)).toBe(state.nonce);

    const sig = await signPermit(fromEip1193(provider, owner), q.unsignedPermit, { account: state.address, chainId: chain.id }, { expectedSigner: state.signer });
    const sub = await relayer.submit({ permit: q.unsignedPermit, signature: sig, quoteId: q.quoteId, idempotencyKey: `app-live:${state.address}:${q.nonce}` });
    const st = await relayer.waitForPermit(sub.id);
    expect(st.status).toBe("INCLUDED");
    console.log(`app live transfer: ${chain.explorerUrl}/#/transaction/${st.txid}`);
  }, 180_000);
});
