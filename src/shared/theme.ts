import { ref } from "vue";
export type ThemePreference = "light" | "dark" | "system";
const stored = localStorage.getItem("tayyn.theme");
export const themePreference = ref<ThemePreference>(
  stored === "light" || stored === "dark" ? stored : "system",
);
const system = window.matchMedia("(prefers-color-scheme: dark)");
function apply() {
  const dark =
    themePreference.value === "dark" ||
    (themePreference.value === "system" && system.matches);
  document.documentElement.classList.toggle("dark", dark);
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", dark ? "#111111" : "#ffffff");
}
export function setTheme(value: ThemePreference) {
  themePreference.value = value;
  localStorage.setItem("tayyn.theme", value);
  apply();
}
system.addEventListener("change", apply);
apply();
