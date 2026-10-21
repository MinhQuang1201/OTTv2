import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./runtime-config";
import { App } from "./app/App";
import "./shared/theme/reset.css";
import "./shared/theme/tokens.css";
import "./shared/theme/global.css";
import { applyTheme, initialTheme } from "./shared/theme/theme";

if (typeof window !== "undefined") {
  applyTheme(initialTheme());
}

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("OTTv2 root element is missing");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
