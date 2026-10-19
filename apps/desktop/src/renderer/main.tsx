import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@gendragoon/ui/theme.css";
import { App } from "./App";

const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
