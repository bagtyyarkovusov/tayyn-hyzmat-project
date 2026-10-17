import { onUnmounted, watch, type Ref } from "vue";
import { driverSession } from "@/features/auth/session";
import { tokens } from "@/shared/api";
import { nativeAndroid, nativeShift } from "./nativeShift";
import { nativeNotifications } from "./nativeNotifications";
import { syncAlertPermission } from "./alerts";

// Installation preferences survive sign-out and reload. A denial or dismissed
// OS dialog must be recovered deliberately through GPS/Profile, not on login.
const attempted = (permission: string) =>
  `tayyn.android.permission-onboarding.${permission}.v1`;
let pending = Promise.resolve();

export function useDriverPermissionOnboarding(
  verifiedDriverView: Ref<boolean>,
) {
  let generation = 0;
  const stop = watch(
    [verifiedDriverView, () => driverSession.state.user?.id],
    ([visible, userId]) => {
      const current = ++generation;
      if (!nativeAndroid || !visible || !userId) return;
      const session = tokens.generation("driver");
      const valid = () =>
        current === generation &&
        verifiedDriverView.value &&
        userId === driverSession.state.user?.id &&
        session === tokens.generation("driver");
      // A replacement session waits for the existing OS dialog to settle.
      // Its obsolete callback cannot request the next permission.
      pending = pending
        .catch(() => {})
        .then(async () => {
          if (!valid()) return;
          try {
            const location = await nativeShift.status();
            if (!valid()) return;
            if (
              location.locationPermission === "prompt" &&
              !localStorage.getItem(attempted("location"))
            ) {
              localStorage.setItem(attempted("location"), "true");
              await nativeShift.permissions();
            }
          } catch {
            // Denying/dismissing location does not deny the separate chat alerts.
          }
          if (!valid()) return;
          try {
            const notifications = await nativeNotifications.status();
            if (!valid()) return;
            if (
              notifications.permission === "prompt" &&
              !localStorage.getItem(attempted("notifications"))
            ) {
              localStorage.setItem(attempted("notifications"), "true");
              await nativeNotifications.requestPermissions();
            }
          } catch {
            // Notifications are optional and never start or block a shift.
          }
          if (valid()) syncAlertPermission();
        });
    },
    { immediate: true },
  );
  onUnmounted(() => {
    generation++;
    stop();
  });
}
