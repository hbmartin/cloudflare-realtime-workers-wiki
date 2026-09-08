import { MantineContext, type MantineColorScheme } from "@mantine/core";
import { useContext, useEffect, useState } from "react";

const STORAGE_KEY = "notes:color-scheme";

const OPTIONS: Array<{ value: MantineColorScheme; label: string; icon: string }> = [
  { value: "light", label: "Light", icon: "☀" },
  { value: "dark", label: "Dark", icon: "☾" },
  { value: "auto", label: "System", icon: "◐" },
];

export function useEffectiveColorScheme() {
  const context = useContext(MantineContext);
  const [observed, setObserved] = useState<"light" | "dark">(() =>
    document.documentElement.getAttribute("data-mantine-color-scheme") === "dark" ? "dark" : "light",
  );
  useEffect(() => {
    const root = document.documentElement;
    const update = () => setObserved(root.getAttribute("data-mantine-color-scheme") === "dark" ? "dark" : "light");
    const observer = new MutationObserver(update);
    observer.observe(root, { attributes: true, attributeFilter: ["data-mantine-color-scheme"] });
    return () => observer.disconnect();
  }, []);
  if (context?.colorScheme === "dark" || context?.colorScheme === "light") return context.colorScheme;
  return observed;
}

export function ThemeControl({ compact = false }: { compact?: boolean }) {
  // App unit tests intentionally render App without its startup provider. Reading
  // the context directly gives the production provider priority while retaining a
  // small, functional fallback for isolated rendering and progressive startup.
  const context = useContext(MantineContext);
  const [fallbackScheme, setFallbackScheme] = useState<MantineColorScheme>(() => {
    try {
      const value = localStorage.getItem(STORAGE_KEY);
      return value === "light" || value === "dark" || value === "auto" ? value : "auto";
    } catch {
      return "auto";
    }
  });
  const colorScheme = context?.colorScheme ?? fallbackScheme;
  const setColorScheme = (value: MantineColorScheme) => {
    if (context) {
      context.setColorScheme(value);
      return;
    }
    setFallbackScheme(value);
    try {
      localStorage.setItem(STORAGE_KEY, value);
    } catch {
      // A storage-denied environment still receives the in-memory preference.
    }
  };
  if (compact) {
    const current = OPTIONS.find((option) => option.value === colorScheme) ?? OPTIONS[2]!;
    const next = colorScheme === "auto" ? "light" : colorScheme === "light" ? "dark" : "auto";
    return (
      <button
        type="button"
        className="theme-compact"
        aria-label={`Theme: ${current.label}. Change theme`}
        title={`Theme: ${current.label}`}
        onClick={() => setColorScheme(next)}
      >
        <span aria-hidden="true">{current.icon}</span>
      </button>
    );
  }
  return (
    <fieldset className="theme-control">
      <legend>Appearance</legend>
      <div>
        {OPTIONS.map((option) => (
          <button
            type="button"
            key={option.value}
            className={colorScheme === option.value ? "selected" : ""}
            aria-pressed={colorScheme === option.value}
            onClick={() => setColorScheme(option.value)}
          >
            <span aria-hidden="true">{option.icon}</span>
            {option.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}
