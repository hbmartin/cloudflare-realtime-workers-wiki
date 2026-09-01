import { useEffect, useState, type ComponentType } from "react";
import { AlertSplash, LoadingSplash } from "./Splash";

export type SupportedAppModule = { default: ComponentType };
export type SupportedAppLoader = () => Promise<SupportedAppModule>;
type StartupState = { kind: "loading" } | { kind: "ready"; SupportedApp: ComponentType } | { kind: "unavailable" };

const loadDefaultSupportedApp: SupportedAppLoader = () => import("./SupportedApp");

function StartupFallback({ kind }: { kind: "unsupported" | "unavailable" }) {
  const unavailable = kind === "unavailable";
  return (
    <AlertSplash
      title={unavailable ? "Workspace unavailable" : "Browser update required"}
      message={
        unavailable
          ? "The application could not be loaded. Refresh the page to try again."
          : "Use Chrome or Edge 116+, Firefox 124+, or Safari 17.4+ to open this workspace."
      }
    />
  );
}

export function Startup({
  supported,
  loadSupportedApp = loadDefaultSupportedApp,
}: {
  supported: boolean;
  loadSupportedApp?: SupportedAppLoader;
}) {
  const [state, setState] = useState<StartupState>({ kind: "loading" });

  useEffect(() => {
    if (!supported) return undefined;
    let active = true;
    void loadSupportedApp().then(
      ({ default: SupportedApp }) => {
        if (active) setState({ kind: "ready", SupportedApp });
      },
      (error) => {
        if (!active) return;
        console.error("The application bundle could not be loaded", error);
        setState({ kind: "unavailable" });
      },
    );
    return () => {
      active = false;
    };
  }, [loadSupportedApp, supported]);

  if (!supported) return <StartupFallback kind="unsupported" />;
  if (state.kind === "ready") return <state.SupportedApp />;
  if (state.kind === "unavailable") return <StartupFallback kind="unavailable" />;
  return <LoadingSplash />;
}
