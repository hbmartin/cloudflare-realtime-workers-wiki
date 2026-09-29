try {
  const saved = localStorage.getItem("notes:color-scheme") || "auto";
  const dark = saved === "dark" || (saved === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.mantineColorScheme = dark ? "dark" : "light";
} catch {
  // The app applies its default theme when storage is unavailable.
}
