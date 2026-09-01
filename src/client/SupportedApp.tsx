import "@mantine/core/styles.css";
import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import { MantineProvider } from "@mantine/core";
import { App } from "./App";

export function SupportedApp() {
  return (
    <MantineProvider defaultColorScheme="light">
      <App />
    </MantineProvider>
  );
}
