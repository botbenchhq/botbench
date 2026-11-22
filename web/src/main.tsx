import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Shell } from "./app/shell.tsx";
// The design system first: tokens, reset, fonts and components, all served by Smelt itself from the build.
import "../vendor/groundwork/groundwork.css";
import "./components/wrap.css";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Shell />
  </StrictMode>,
);
