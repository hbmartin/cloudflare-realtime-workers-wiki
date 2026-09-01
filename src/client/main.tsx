import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { browserSupportsRequiredFeatures } from "./browser-support";
import { Startup } from "./startup";
import "./startup.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Startup supported={browserSupportsRequiredFeatures()} />
  </StrictMode>,
);
