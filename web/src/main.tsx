import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { startServiceWorker } from "./app/notifications.ts";
import { Shell } from "./app/shell.tsx";
// The design system first: tokens, reset, fonts and components, all served by Botbench itself from the build.
import "../vendor/design-system/design-system.css";
// Then the Botbench theme, which sets the tokens to the brand's values. Its default mode is dark: the root carries no data-theme.
import "../vendor/design-system/themes/botbench.css";
import "./index.css";

// Installable and notified (unit 23): the service worker shows notifications and opens the screen one names.
startServiceWorker();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Shell />
  </StrictMode>,
);
