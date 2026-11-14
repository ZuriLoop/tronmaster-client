# Send USDT on Tron without TRX

A self-custodial web app: connect a wallet you already have, get a Tron USDT
address, and send from it without ever holding TRX. A relayer pays the network
fee and is repaid in USDT out of the transfer.

This is the app itself, not a cut-down sample: the same code that runs at
the hosted deployment.

## Run it

```sh
pnpm install
pnpm --filter @tron-paymaster/sdk build
pnpm dev
```

It points at Nile and the public test factory by default. Configure with:

| Variable | Meaning |
|---|---|
| `VITE_TPM_NETWORK` | `nile` (default) or `mainnet` |
| `VITE_TPM_RELAYER` | default relayer URL; when unset the UI asks for one |
| `VITE_TPM_FACTORY` | override the factory address |
| `VITE_TPM_SPONSORSHIP_POLICY` | a sponsorship policy to ask for — users then send for free |
| `VITE_TPM_API_KEY` | the key that proves which project owns that policy |

**The network is a build-time constant on purpose.** An account address
commits to its factory, so an address derived on one network has no code — and
can never have code — on the other. A runtime network switch would let a user
fund an address nobody can ever deploy. Deploy testnet and mainnet separately.

You also need a relayer. Relaying is permissionless — the app accepts any
relayer URL, and running your own is the point rather than a fallback. See
[Running your own relayer](../README.md#running-your-own-relayer).

## Design

The app uses [`@tron-paymaster/theme`](../theme), one set of design tokens
with a button and a logo, so anything built alongside it matches without a
second palette. Dark mode is a class on `<html>` set before paint, from the
`theme` key in `localStorage`.

## What it is careful about

- **Two addresses.** The gasless address is not the wallet's own Tron address,
  and USDT already sitting in a TRX-less wallet cannot be moved into it. The
  receive screen leads with this.
- **USDT only.** TRX or other tokens sent to the account may be unrecoverable
  for a user whose wallet cannot sign Tron transactions; the screen says so.
- **Base58 recipients only.** `parseTronAddress` accepts `0x…` hex, which
  means a pasted Ethereum deposit address is a *valid* Tron recipient and the
  funds are burned. The send box rejects it with an explanation.
- **Spendable, not raw, balance.** Relayer fees accrue as a debt inside the
  account until claimed, so the app shows `available`.
- **Dust.** An amount at or below the fee is refused with the real floor
  rather than a generic failure.
- **EVM wallets and the network check.** MetaMask refuses typed data whose
  chain id is not its active chain; the signer adds and switches to Tron first.
- **Recovery.** Every derivation parameter is shown and exportable, and the
  app states plainly that an EVM-wallet user's no-relayer exit requires
  importing the same key into a Tron wallet.

## Tests

```sh
pnpm --filter @tron-paymaster/app test     # error copy + recipient validation

# Against live Nile, with a relayer running and a funded account:
APP_LIVE=1 APP_RELAYER=http://127.0.0.1:8787 APP_OWNER_KEY=0x… \
  pnpm --filter @tron-paymaster/app test
```

The live test drives the app's own config and signing path with a stub
EIP-1193 wallet — the same shape MetaMask presents — so the full journey is
covered without a browser.

## Hosting it

The build is static — no server, no keys, no backend at all — so it can be
hosted anywhere. [`wrangler.jsonc`](wrangler.jsonc) configures Cloudflare
Workers static assets, with unmatched paths falling back to `index.html` so
deep links work:

```sh
pnpm --filter @tron-paymaster/app build
pnpm --filter @tron-paymaster/app deploy      # wrangler deploy
```

CI does the same on every push to `main`
([deploy.yml](../.github/workflows/deploy.yml)), but only once the
repository sets the variable `DEPLOY_APP=true` and the secrets
`CLOUDFLARE_API_TOKEN` (scope: *Edit Cloudflare Workers*) and
`CLOUDFLARE_ACCOUNT_ID`. The network, relayer and factory come from the
repository variables `TPM_NETWORK`, `TPM_RELAYER` and `TPM_FACTORY` at build
time, so a testnet and a mainnet deployment are two separate Workers.
