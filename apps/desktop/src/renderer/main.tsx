import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@gendragoon/ui/theme.css";
import { initTheme } from "@gendragoon/ui";
import { App } from "./App";

// Apply the saved theme (dark by default) before React renders, so there is no flash.
initTheme();

const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
