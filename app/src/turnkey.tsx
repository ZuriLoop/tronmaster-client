/**
 * The Turnkey passkey wallet, kept out of the main bundle.
 *
 * The wallet kit is large — it carries its own UI, animations and chain
 * integrations — and most people running this app will never turn Turnkey on.
 * So it is behind a dynamic import that only resolves when an organization is
 * configured, and the build without one is exactly the size it was before.
 */
import { Suspense, lazy } from "react";
import { turnkey } from "./config.js";

const TurnkeyShell = lazy(() => import("./turnkeyShell.js"));

/** Mounts the Turnkey wallet alongside the app, when configured. */
export function WithTurnkey({ children }: { children: React.ReactNode }) {
  return (
    <>
      {turnkey && (
        <Suspense fallback={null}>
          <TurnkeyShell />
        </Suspense>
      )}
      {children}
    </>
  );
}
