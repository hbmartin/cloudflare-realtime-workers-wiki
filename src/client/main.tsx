import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { browserSupportsRequiredFeatures } from "./browser-support";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);
const render = (content: ReactNode) => root.render(<StrictMode>{content}</StrictMode>);

if (browserSupportsRequiredFeatures()) {
  void import("./SupportedApp").then(
    ({ SupportedApp }) => render(<SupportedApp />),
    (error) => {
      console.error("The application bundle could not be loaded", error);
      render(
        <main className="splash">
          <h1>Workspace unavailable</h1>
          <p>The application could not be loaded. Refresh the page to try again.</p>
        </main>,
      );
    },
  );
} else {
  render(
    <main className="splash">
      <h1>Browser update required</h1>
      <p>Use Chrome or Edge 116+, Firefox 124+, or Safari 17.4+ to open this workspace.</p>
    </main>,
  );
}
