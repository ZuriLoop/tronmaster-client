# `@tron-paymaster/react`

React hooks for gasless Tron USDT. Your users receive at an address derived
from their own key and send from it **without ever holding TRX** — a relayer
pays the network fee and is repaid in USDT out of the transfer.

Works with the wallet they already have: TronLink, or **any EVM wallet**
(MetaMask, Rabby) — Tron and Ethereum share the same key curve, and a permit
is EIP-712 typed data, so an EVM wallet signs it natively.

```sh
npm install @tron-paymaster/react @tron-paymaster/sdk viem react
```

## Five minutes

```tsx
import { TronPaymasterProvider, useWallet, useAccount, useTransfer } from "@tron-paymaster/react";

const config = { chain: "nile", relayerUrl: "https://relayer.example" };

export default () => (
  <TronPaymasterProvider config={config}>
    <Send />
  </TronPaymasterProvider>
);

function Send() {
  const wallet = useWallet();
  const { account } = useAccount(wallet.connection?.owner);
  const transfer = useTransfer(wallet.connection?.owner);

  if (!wallet.connection) {
    return wallet.available.map((w) => (
      <button key={w.kind} onClick={() => wallet.connect(w.kind)}>Connect {w.name}</button>
    ));
  }
  if (!account) return <p>loading…</p>;

  return (
    <>
      {/* Fund this address — it works before it exists on-chain */}
      <code>{account.address}</code>
      <p>{account.available.toString()} available</p>

      <button onClick={() => transfer.getQuote({ to: "T…", amount: "5", available: account.available, deployed: account.deployed })}>
        Quote
      </button>

      {transfer.quote && (
        <button onClick={() => transfer.send({ signer: wallet.connection!.signer })}>
          Sign and send
        </button>
      )}
      {transfer.error && <p>{transfer.error}</p>}
    </>
  );
}
```

## The hooks

| Hook | What it gives you |
|---|---|
| `useWallet()` | every installed wallet by name and icon (EIP-6963), `connect(kind, id)`, the connection (owner address + a permit signer), reconnect to the *same* wallet, and account-change handling |
| `useAccount(owner)` | the gasless account: address, **spendable** balance, nonce, deployed flag, polled |
| `useTransfer(owner)` | `getQuote` → `quote` → `send`, as a phase machine: `idle · quoting · ready · signing · submitting · pending · done · failed` |

Plus `validateRecipient()` and `explain()` — see below, both matter more than
they look.

## Four things this gets right for you

**It connects to the wallet the user picked.** `window.ethereum` is one slot
that every injected wallet fights over, and several set `isMetaMask: true` on
purpose, so reading it connects to whoever won the race under a name that may
not be theirs. `useWallet` uses EIP-6963: every wallet is listed by its own
name and icon, `connect(kind, id)` takes the one chosen, and a reconnect goes
back to that same wallet rather than to whatever holds the slot now.

**Quotes are verified, not trusted.** `getQuote` checks the relayer's permit
field-by-field against what you asked for, bounds the fee and deadline, and
independently confirms the account and nonce against the chain. A dishonest
relayer throws before anything reaches your UI.

**`validateRecipient` refuses `0x…` addresses.** The SDK's address parser
accepts hex, which means a pasted **Ethereum** deposit address is a *valid*
Tron recipient and the funds are burned. Use this on your input; it rejects
hex with an explanation a user can act on.

**`account.available`, not the raw balance.** Relayer fees accrue as a debt
inside the account until claimed, so the raw token balance overstates what can
be sent. Showing it makes "send max" fail for no visible reason.

**`explain(error)` turns protocol errors into sentences.** Wallet rejection,
a relayer out of capacity, an expired quote, a raced nonce, dust below the
fee — each becomes something a non-technical user can act on. A raw error
reaching your screen is a bug.

## Sponsoring your users' fees

Add a policy id and the key that owns it to the config, and your users stop
paying the relayer fee:

```tsx
const config = {
  chain: "nile",
  relayerUrl: "https://relayer.example",
  sponsorshipPolicyId: "sp_…",
  apiKey: "tpm_nile_…",
};
```

`quote.sponsored` then tells you whether this transfer is covered, and
`quote.sponsorshipDeclined` says why it is not — a limit reached, a recipient
the policy does not cover. **A decline is never a failure**: the quote is
priced as usual and the user can pay for it. Keep the fee line visible either
way: the protocol fee still comes out of their balance.

## Two things to tell your users

- **The gasless address is not their wallet's Tron address.** It is derived
  from the same key, but USDT already sitting in their ordinary address will
  not appear there — and moving it there would itself cost TRX. Say this on
  the receive screen.
- **An EVM wallet cannot sign Tron transactions.** That is fine for sending
  here, which only needs a signature. But withdrawing without any relayer,
  and `invalidateNonces` / `setSigner`, are Tron transactions — reachable by
  importing the same key into a Tron wallet. State it before they fund an
  account, not after.

## Run your own relayer and keep the fee

Relaying is permissionless: no registry, no API key, no approval. A wallet
can run the open-source reference relayer and keep the relayer fee rather than
paying someone else's — see [Running your own relayer](../README.md#running-your-own-relayer).

A full reference implementation using these hooks is in
[`app/`](../app).

> **Unaudited.** Do not use with significant funds yet.
