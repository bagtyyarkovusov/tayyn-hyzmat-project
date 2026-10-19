import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { nativeAndroid } from "./nativeShift";

type Insets = { top: number; right: number; bottom: number; left: number };
type BackResult = "handled" | "root";
interface DriverUiPlugin {
  ready(): Promise<Insets>;
  respondBack(options: {
    requestId: number;
    result: BackResult;
  }): Promise<void>;
  resetBack(): Promise<void>;
  detach(): Promise<void>;
  theme(options: { dark: boolean }): Promise<void>;
  addListener(
    event: "insets",
    callback: (insets: Insets) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    event: "back",
    callback: (event: { requestId: number }) => void,
  ): Promise<PluginListenerHandle>;
}
const ui = registerPlugin<DriverUiPlugin>("DriverUi");
export function resetNativeBack() {
  if (nativeAndroid) void ui.resetBack().catch(() => {});
}
/** Install once in the shell. The shell closes its topmost overlay or navigates
 * one level before returning handled. Orders root returns root, as does a
 * press during a new offer's Back guard (the offer stays open). */
export async function installNativeUi(
  handleBack: () => BackResult | Promise<BackResult>,
) {
  if (!nativeAndroid) return () => {};
  let disposed = false;
  const applyInsets = (insets: Insets) => {
    if (disposed) return;
    for (const side of ["top", "right", "bottom", "left"] as const)
      document.documentElement.style.setProperty(
        `--native-safe-${side}`,
        `${insets[side]}px`,
      );
  };
  const insetListener = await ui.addListener("insets", applyInsets);
  const backListener = await ui.addListener("back", ({ requestId }) => {
    void Promise.resolve()
      .then(handleBack)
      .then((result) => {
        if (!disposed) return ui.respondBack({ requestId, result });
      })
      .catch(() => {
        if (!disposed) void ui.respondBack({ requestId, result: "handled" });
      });
  });
  const syncTheme = () =>
    void ui
      .theme({ dark: document.documentElement.classList.contains("dark") })
      .catch(() => {});
  const observer = new MutationObserver(syncTheme);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  document.addEventListener("visibilitychange", syncTheme);
  syncTheme();
  applyInsets(await ui.ready());
  return () => {
    disposed = true;
    observer.disconnect();
    document.removeEventListener("visibilitychange", syncTheme);
    void insetListener.remove();
    void backListener.remove();
    void ui.detach().catch(() => {});
  };
}
