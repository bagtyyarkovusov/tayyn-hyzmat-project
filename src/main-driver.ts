import { createApp } from "vue";
import App from "./App.vue";
import { nativeAndroid, nativeShift } from "./features/driver/nativeShift";
import { makeRouter } from "./app-router";
import "./shared/theme.css";
import "./shared/theme";
const router = makeRouter(true);
createApp(App, { driverOnly: true }).use(router).mount("#app");
async function openNotification() {
  if (!nativeAndroid) return;
  const target = await nativeShift.notificationTarget();
  if (target.channel) {
    window.dispatchEvent(
      new CustomEvent("native:notification", { detail: target }),
    );
    await router.push(
      target.channel === "chat" ? "/driverChat" : "/driverDashboard",
    );
  }
}
void router.isReady().then(openNotification);
window.addEventListener("focus", () => void openNotification());
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void openNotification();
});

if (nativeAndroid)
  void nativeShift.addListener(
    "notificationTarget",
    () => void openNotification(),
  );
