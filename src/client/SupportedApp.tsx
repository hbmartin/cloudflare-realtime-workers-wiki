import "@mantine/core/styles.css";
import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import { localStorageColorSchemeManager, MantineProvider } from "@mantine/core";
import { App } from "./App";
import "./styles.css";

/** @expected-unused -- Loaded through the feature-gated dynamic import in startup.tsx. */
export default function SupportedApp() {
  return (
    <MantineProvider
      defaultColorScheme="auto"
      colorSchemeManager={localStorageColorSchemeManager({ key: "notes:color-scheme" })}
    >
      <App />
    </MantineProvider>
  );
}
