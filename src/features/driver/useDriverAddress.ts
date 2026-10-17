import { driverApi } from "@/shared/api";
import {
  useLocationAddress,
  type AddressPolicy,
} from "@/shared/useLocationAddress";

export function useDriverAddress(
  position: () => { lat: number; lng: number } | null,
  account: () => string | undefined,
  enabled: () => boolean,
  policy: Omit<AddressPolicy, "installation">,
) {
  return useLocationAddress(position, account, driverApi, enabled, {
    ...policy,
    installation: () => localStorage.getItem("openride.driver.deviceId") || "",
  });
}
