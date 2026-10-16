import { driverApi } from "@/shared/api";
import { useLocationAddress } from "@/shared/useLocationAddress";

export function useDriverAddress(
  position: () => { lat: number; lng: number } | null,
  account: () => string | undefined,
  enabled: () => boolean,
) {
  return useLocationAddress(position, account, driverApi, enabled);
}
