# Security

## Status: unaudited

The contracts this client talks to have not been through a third-party audit.
There is no mainnet deployment. Treat anything here as experimental and do not
put money you care about through it.

## Scope

This repository is the client — everything that runs in a browser:

- `app/` — the web app
- `sdk/` — address derivation, permit construction and signing, relayer client
- `react/` — the hooks
- `theme/` — presentation only

The contracts, the reference relayer and the CLI are not in this repository.
A finding in those belongs upstream, not here.

Things that are in scope and worth looking at hardest:

- **Address derivation** (`sdk/src/create2.ts`, `sdk/src/chains.ts`). An
  address that derives differently from the on-chain factory is funds sent
  somewhere nobody can reach.
- **Permit construction and the TIP-712 domain** (`sdk/src/permit.ts`,
  `sdk/src/sign.ts`). A permit that signs over different bytes than the
  contract verifies, or a domain that lets a signature be replayed on another
  chain or another account, is the worst thing that can happen here.
- **What the client verifies before it signs** (`sdk/src/relayerClient.ts`).
  A relayer is untrusted by design. The client re-checks every field of the
  permit against the request and refuses a quote that does not match; a gap in
  that check is a relayer being able to alter a transfer.
- **Recipient handling** (`sdk/src/address.ts`, the send form). `0x…` hex is a
  valid Tron address, so a pasted Ethereum deposit address is accepted by the
  parser and the funds are gone. The UI refuses it; a path around that refusal
  is a real bug.

## Reporting

Report privately through GitHub's security advisories on this repository
("Security" → "Report a vulnerability"), not through a public issue.

Please include what an attacker gains and the smallest reproduction you have.
A proof of concept against Nile testnet is ideal and costs nothing.
