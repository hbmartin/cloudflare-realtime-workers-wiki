import "@mantine/core/styles.css";
import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import { MantineProvider } from "@mantine/core";
import { App } from "./App";
import "./styles.css";

/** @expected-unused -- Loaded through the feature-gated dynamic import in startup.tsx. */
export default function SupportedApp() {
  return (
    <MantineProvider defaultColorScheme="light">
      <App />
    </MantineProvider>
  );
}
