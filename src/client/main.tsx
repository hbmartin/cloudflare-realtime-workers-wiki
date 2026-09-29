import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { browserSupportsRequiredFeatures } from "./browser-support";
import { Startup } from "./startup";
import "./startup.css";
import { installClientTelemetry } from "./telemetry";

installClientTelemetry();

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    try {
      void navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).catch((error: unknown) => {
        console.error("Could not prepare offline app shell", error);
      });
    } catch (error) {
      console.error("Could not prepare offline app shell", error);
    }
  });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Startup supported={browserSupportsRequiredFeatures()} />
  </StrictMode>,
);
