# TronMaster client

Send Tron USDT without holding TRX.

Connect a wallet you already have — MetaMask, TronLink, anything that signs —
and you get a Tron address you control. USDT sent there can be spent straight
away: a relayer submits the transaction, pays the network fee, and is repaid in
USDT out of the transfer itself. You never acquire TRX, and nobody takes
custody of your money.

**Live on Nile testnet:** https://tron-paymaster-app.prince-c5a.workers.dev

## How it works

Your account is a contract whose address is derived from your own public key
and a factory address, with CREATE2. That derivation is the whole trick:

- **The address exists before the contract does.** It can receive USDT while
  no code is deployed to it, and it deploys itself on the first spend. You are
  not paying to open an account.
- **It obeys only your signature.** Spending is authorised by a TIP-712 permit
  — the same typed data your wallet already knows how to sign — naming the
  token, the amount, the recipient, the maximum fee and a deadline. A relayer
  can execute that permit and nothing else.
- **Nobody can take it away.** The address is a function of your key. Anyone
  can recompute it with this SDK, and the owner can always withdraw directly
  without any relayer by paying their own energy.

Tron and Ethereum use the same secp256k1 curve, which is why an EVM wallet's
key is already a valid Tron owner key. That is why MetaMask works here at all.

## Run it

```sh
pnpm install
pnpm --filter @tron-paymaster/sdk build
pnpm dev
```

It points at Nile and the public test factory by default. Configuration is
build-time; see [`app/.env.example`](app/.env.example).

You also need a relayer — see below.

## Running your own relayer

Relaying is permissionless. There is no registry, no API key and no approval:
a relayer is just an address that holds the energy to submit transactions and
is willing to be repaid in USDT. The app accepts any relayer URL, and running
your own means you keep the relayer fee instead of paying someone else's.

A relayer must:

1. Serve `POST /v1/quote` — price a transfer and return an unsigned permit
   bound to itself, with an HMAC-authenticated `quoteId`.
2. Serve `POST /v1/submit` — take the signed permit, verify it matches the
   quote, acquire energy, and broadcast.
3. Serve `GET /v1/status/:id` and `GET /v1/info`.

The exact types are in [`sdk/src/relayerClient.ts`](sdk/src/relayerClient.ts),
which is also the client the app uses — so the types are the specification.

The economics are energy. A transfer costs energy on Tron, which a relayer can
burn TRX for, rent from an energy market, or serve from its own staked TRX,
cheapest first. The fee charged should cover that plus a margin. USDT's dynamic
energy penalty makes a mainnet transfer several times dearer than a testnet
one, so price from measurement, not from a testnet figure.

## What's here

| | |
|---|---|
| [`app/`](app) | The web app. React, Vite, static build, no server. |
| [`sdk/`](sdk) | Address derivation, permits, the relayer client. No dependencies but `viem`. |
| [`react/`](react) | Hooks: `useWallet`, `useAccount`, `useTransfer`. |
| [`theme/`](theme) | Design tokens, button, logo. |

## Status

**Unaudited.** The contracts this talks to have not been through a third-party
audit. Nile testnet only so far; there is no mainnet deployment. Do not put
money you care about through it.

The contracts, the reference relayer and the CLI live in a separate repository
and are not included here. This repo is the client: everything that runs in a
browser.

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
