# Contributing

Issues and pull requests are welcome.

## One thing to know first

This repository is a **copy**. `app/`, `sdk/`, `react/` and `theme/` are
developed in the protocol repository alongside the contracts, the reference
relayer and the CLI, and are copied here. The sync is one-way.

That means a fix landed here does not reach the protocol repository on its own
— someone has to carry it across by hand. So:

- **Bug reports and discussion: here, always.** This is the right place.
- **Patches: also fine here.** They will be applied upstream and arrive back in
  the next sync, so your change may appear in a later commit that does not
  carry your authorship through the copy. Say so in the PR if that matters to
  you and it will be preserved in the upstream commit.

This is an honest cost of publishing the client separately, not an accident.

## Working on it

```sh
pnpm install
pnpm --filter @tron-paymaster/sdk build
pnpm dev
```

```sh
pnpm -r typecheck
pnpm -r test
```

Tests run in Node with no DOM — there is no jsdom and no testing-library here.
The pattern is to export a pure function and table-test it; see
`react/test/explain.test.ts`. If a behaviour matters enough to test, it is
usually worth extracting from the component anyway.

## What good looks like here

- **Comments explain why, not what.** The code says what it does.
- **Anything user-facing says something true.** The client cannot know which
  energy a relayer actually spent, so it does not claim to. Wording that
  overstates what is known is treated as a bug.
- **No secret ever enters a `VITE_*` variable.** Every one of them is compiled
  into a public bundle that ships source maps.
