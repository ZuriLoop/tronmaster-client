import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { TronPaymasterProvider } from "@tron-paymaster/react";
import { App } from "./App.js";
import { providerConfig } from "./config.js";
import "@tron-paymaster/theme/theme.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <TronPaymasterProvider config={providerConfig}>
      <App />
    </TronPaymasterProvider>
  </StrictMode>,
);
