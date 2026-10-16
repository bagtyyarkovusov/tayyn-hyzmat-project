import { createApp } from "vue";
import App from "./App.vue";
import { makeRouter } from "./app-router";
import "./shared/theme.css";
import "./shared/theme";
const router = makeRouter(true);
const app = createApp(App).use(router);
void router.isReady().then(() => app.mount("#app"));
