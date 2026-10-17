package io.openride.driver;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** External navigation never replaces the driver WebView or ends its shift. */
@CapacitorPlugin(name = "DriverNavigation")
public class DriverNavigationPlugin extends Plugin {
  @PluginMethod
  public void open(PluginCall call) {
    Double lat = call.getDouble("lat"), lng = call.getDouble("lng");
    if (!NavigationCoordinates.valid(lat, lng)) {
      call.reject("Точка маршрута недоступна.");
      return;
    }
    String query = "rtext=~" + lat + "," + lng + "&rtt=auto";
    getActivity().runOnUiThread(() -> {
      try {
        try {
          Intent app = new Intent(Intent.ACTION_VIEW,
              Uri.parse("yandexmaps://maps.yandex.ru/?" + query));
          app.setPackage("ru.yandex.yandexmaps");
          getActivity().startActivity(app);
        } catch (ActivityNotFoundException missingApp) {
          getActivity().startActivity(new Intent(Intent.ACTION_VIEW,
              Uri.parse("https://yandex.ru/maps/?" + query)));
        }
        call.resolve();
      } catch (RuntimeException error) {
        call.reject("Не удалось открыть карту. Установите браузер или Яндекс Карты.");
      }
    });
  }
}
