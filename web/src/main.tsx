import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Shell } from "./app/shell.tsx";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Shell />
  </StrictMode>,
);
