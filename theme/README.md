# `@tron-paymaster/theme`

The TronMaster design system: colour tokens, radii, gradients and shadows, the
`Button`, and the logo. Every front end imports from here so there is one
brand rather than one per app.

```ts
import "@tron-paymaster/theme/theme.css";   // tokens + Tailwind
import { Button } from "@tron-paymaster/theme/button";
import { cn } from "@tron-paymaster/theme/cn";
import logo from "@tron-paymaster/theme/logo.png";
```

`theme.css` holds every token. Add a colour here rather than in a consumer:
a token that exists in one place and not the other is how one product starts
looking like two. One deliberate divergence is noted in the file — on an ink
background the primary gradient's light-mode ramp left its near-black label
muddy, so the dark theme lifts the ramp rather
than changing the text colour.

The file carries `@source "./src"` so Tailwind scans this package's own
components for class names; without it the `Button` variants would be stripped
from a consumer's stylesheet.

## Using it

- Colour comes from semantic tokens — `bg-card`, `text-muted-foreground`,
  `border-foreground/10` — never from a raw hex or a Tailwind palette name, so
  dark mode works without a second rule.
- Surfaces are `rounded-2xl border border-foreground/10 bg-card shadow-card`.
  Pills (nav, tabs, toasts) are `rounded-full`.
- `Button` variants: `default`, `outline`, `ghost`, `destructive`,
  `secondary`, `link`, plus the branded `hero` (gradient, lifts on hover),
  `gold` and `ink`.
- Dark mode is a `dark` class on `<html>`, set before paint from
  `localStorage.theme`. The key is the plain string `theme`, so any other page
  on the same origin that honours it inherits the visitor's choice.
