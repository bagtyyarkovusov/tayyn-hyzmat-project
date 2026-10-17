<script setup lang="ts">
import { date, type Driver } from "../domain";
defineProps<{ driver: Driver; now: number }>();
function locationLabel(driver: Driver, now: number) {
  if (driver.lastLat == null || driver.lastLng == null)
    return "Координат пока нет";
  const timestamp = Date.parse(driver.lastLocationAt ?? "");
  if (!Number.isFinite(timestamp)) return "Время координат неизвестно";
  if (!driver.isOnline)
    return "Последнее местоположение · обновление остановлено";
  return now - timestamp > 60_000
    ? "Координаты устарели"
    : "Координаты обновлены";
}
</script>
<template>
  <div class="min-w-0 space-y-2 break-words text-sm">
    <p class="font-semibold">{{ driver.user.fullName }}</p>
    <p>
      {{
        [driver.currentVehicle?.make, driver.currentVehicle?.model]
          .filter(Boolean)
          .join(" ")
      }}
      <span class="font-medium">{{
        driver.currentVehicle?.plateNumber || "Нет машины"
      }}</span>
    </p>
    <p>{{ driver.district?.name || "Район не определён" }}</p>
    <p>
      {{ driver.isOnline ? "На линии" : "Не в сети" }}
      <template v-if="driver.hasActiveTrip">
        · {{ driver.isOnline ? "В поездке" : "Поездка не завершена" }}
      </template>
      <template v-else-if="driver.isOnline">
        · {{ driver.isAvailable ? "Свободен" : "Занят" }}
      </template>
    </p>
    <p class="text-xs text-muted-foreground">
      {{ locationLabel(driver, now) }}
      <time
        v-if="driver.lastLocationAt"
        :datetime="driver.lastLocationAt"
        class="block"
        >{{ date(driver.lastLocationAt) }}</time
      >
    </p>
  </div>
</template>
