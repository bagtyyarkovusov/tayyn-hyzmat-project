package io.openride.driver;

import android.Manifest;
import android.content.*;
import android.location.*;
import android.os.*;
import android.provider.Settings;
import androidx.core.content.ContextCompat;
import com.getcapacitor.*;
import com.getcapacitor.annotation.*;
import java.net.URI;

@CapacitorPlugin(
    name = "DriverShift",
    permissions = {
      @Permission(
          alias = "location",
          strings = {
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION
          }),
      @Permission(
          alias = "notifications",
          strings = {Manifest.permission.POST_NOTIFICATIONS})
    })
public class DriverShiftPlugin extends Plugin {
  private LocationManager manager;
  private LocationListener oneShot;
  private final Handler timer = new Handler(Looper.getMainLooper());
  private PluginCall locationCall;

  private JSObject nativeStatus() {
    try {
      JSObject result = JSObject.fromJSONObject(ShiftService.status(getContext()));
      result.put("locationGranted", getPermissionState("location") == PermissionState.GRANTED);
      PermissionState permission = getPermissionState("location");
      result.put("locationPermission", permission == PermissionState.GRANTED ? "granted" :
          permission == PermissionState.PROMPT ? "prompt" : "denied");
      LocationManager locations = (LocationManager) getContext().getSystemService(Context.LOCATION_SERVICE);
      result.put("locationEnabled", locations != null && locations.isProviderEnabled(LocationManager.GPS_PROVIDER));
      return result;
    } catch (org.json.JSONException error) {
      return new JSObject();
    }
  }

  @PluginMethod
  public void permissions(PluginCall call) {
    requestPermissionForAlias("location", call, "permissionResult");
  }

  @PermissionCallback
  private void permissionResult(PluginCall call) {
    JSObject result = nativeStatus();
    result.put("locationGranted", getPermissionState("location") == PermissionState.GRANTED);
    LocationManager locations =
        (LocationManager) getContext().getSystemService(Context.LOCATION_SERVICE);
    result.put("locationEnabled",
        locations != null && locations.isProviderEnabled(LocationManager.GPS_PROVIDER));
    call.resolve(result);
  }

  @PluginMethod
  public void status(PluginCall call) {
    call.resolve(nativeStatus());
  }

  @Override
  protected void handleOnNewIntent(Intent intent) {
    getActivity().setIntent(intent);
    String channel = intent.getStringExtra("notificationChannel");
    if (channel != null)
      notifyListeners("notificationTarget", new JSObject().put("channel", channel), true);
  }

  @PluginMethod
  public void notificationTarget(PluginCall call) {
    Intent intent = getActivity().getIntent();
    String channel = intent.getStringExtra("notificationChannel");
    intent.removeExtra("notificationChannel");
    call.resolve(new JSObject().put("channel", channel == null ? "" : channel));
  }

  @PluginMethod
  public void settings(PluginCall call) {
    Intent intent =
        Build.VERSION.SDK_INT >= 26
            ? new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, getContext().getPackageName())
            : new Intent(
                Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                android.net.Uri.parse("package:" + getContext().getPackageName()));
    getActivity().startActivity(intent);
    call.resolve();
  }

  @PluginMethod
  public void location(PluginCall call) {
    if (getPermissionState("location") != PermissionState.GRANTED) {
      call.reject("Разрешите точный GPS в настройках приложения.");
      return;
    }
    getActivity()
        .runOnUiThread(
            () -> {
              if (locationCall != null) {
                call.reject("Ожидаем координаты GPS.");
                return;
              }
              locationCall = call;
              manager = (LocationManager) getContext().getSystemService(Context.LOCATION_SERVICE);
              if (!manager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                finishLocation(null, "Включите GPS телефона.");
                return;
              }
              oneShot =
                  new LocationListener() {
                    @Override
                    public void onLocationChanged(Location fix) {
                      long age = SystemClock.elapsedRealtimeNanos() - fix.getElapsedRealtimeNanos();
                      if (age < 0 || age > 30000000000L) return;
                      finishLocation(fix, null);
                    }

                    @Override
                    public void onProviderDisabled(String provider) {
                      finishLocation(null, "Включите GPS телефона.");
                    }

                    @Override
                    public void onProviderEnabled(String provider) {}

                    @Override
                    public void onStatusChanged(String provider, int status, Bundle extras) {}
                  };
              try {
                manager.requestLocationUpdates(
                    LocationManager.GPS_PROVIDER, 0, 0, oneShot, Looper.getMainLooper());
                timer.postDelayed(
                    () ->
                        finishLocation(
                            null,
                            "GPS временно недоступен. Выйдите на открытое место и повторите."),
                    20000);
              } catch (SecurityException error) {
                finishLocation(null, "Разрешите точный GPS в настройках приложения.");
              }
            });
  }

  private void finishLocation(Location fix, String error) {
    PluginCall call = locationCall;
    locationCall = null;
    timer.removeCallbacksAndMessages(null);
    if (manager != null && oneShot != null) manager.removeUpdates(oneShot);
    oneShot = null;
    if (call == null) return;
    if (error != null) call.reject(error);
    else
      call.resolve(
          new JSObject()
              .put("lat", fix.getLatitude())
              .put("lng", fix.getLongitude())
              .put("accuracy", fix.getAccuracy())
              .put("timestamp", fix.getTime()));
  }

  @PluginMethod
  public void start(PluginCall call) {
    String endpoint = call.getString("apiBase", "");
    String token = call.getString("shiftToken", "");
    try {
      URI uri = new URI(endpoint);
      if (!"https".equals(uri.getScheme())
          || uri.getHost() == null
          || uri.getUserInfo() != null
          || uri.getQuery() != null
          || uri.getFragment() != null) throw new Exception();
      if (token.length() < 32) throw new Exception();
    } catch (Exception error) {
      call.reject("Для APK требуется защищённый HTTPS API.");
      return;
    }
    if (getPermissionState("location") != PermissionState.GRANTED) {
      call.reject("Разрешите GPS телефона.");
      return;
    }
    if (ShiftService.status(getContext()).optBoolean("running")) {
      call.reject("Смена уже запущена.");
      return;
    }
    Intent intent =
        new Intent(getContext(), ShiftService.class)
            .putExtra("apiBase", endpoint.replaceAll("/+$", ""))
            .putExtra("token", token)
            .putExtra("userId", call.getString("userId", ""))
            .putExtra("leaseDurationMs", call.getLong("leaseDurationMs", 60000L));
    try {
      ContextCompat.startForegroundService(getContext(), intent);
      call.resolve();
    } catch (RuntimeException error) {
      call.reject("Не удалось запустить смену. Откройте приложение и повторите.");
    }
  }

  @PluginMethod
  public void stop(PluginCall call) {
    ShiftService.end(getContext(), call.getString("shiftToken"));
    call.resolve();
  }

  @PluginMethod
  public void clear(PluginCall call) {
    ShiftService.clear(call.getString("channel", "orders"));
    call.resolve();
  }

  @Override
  protected void handleOnDestroy() {
    finishLocation(null, "Запрос GPS отменён.");
    super.handleOnDestroy();
  }
}
