package io.openride.driver;

import android.Manifest;
import android.content.*;
import android.content.pm.PackageManager;
import android.location.*;
import android.os.*;
import android.provider.Settings;
import androidx.activity.result.ActivityResult;
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
  private LocationAcquisition acquisition;
  private long locationGeneration;
  private String locationRequestKey;
  private final Handler timer = new Handler(Looper.getMainLooper());
  private PluginCall locationCall;

  private JSObject nativeStatus() {
    try {
      JSObject result = JSObject.fromJSONObject(ShiftService.status(getContext()));
      result.put("locationGranted", preciseGranted());
      result.put("locationCoarseGranted", coarseGranted());
      PermissionState permission = getPermissionState("location");
      result.put(
          "locationPermission",
          permission == PermissionState.GRANTED
              ? "granted"
              : permission == PermissionState.PROMPT ? "prompt" : "denied");
      LocationManager locations =
          (LocationManager) getContext().getSystemService(Context.LOCATION_SERVICE);
      result.put("locationEnabled", LocationAcquisition.enabled(locations));
      return result;
    } catch (org.json.JSONException error) {
      return new JSObject();
    }
  }

  private boolean preciseGranted() {
    return ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACCESS_FINE_LOCATION)
        == PackageManager.PERMISSION_GRANTED;
  }

  private boolean coarseGranted() {
    return ContextCompat.checkSelfPermission(
            getContext(), Manifest.permission.ACCESS_COARSE_LOCATION)
        == PackageManager.PERMISSION_GRANTED;
  }

  @PluginMethod
  public void permissions(PluginCall call) {
    // Onboarding requests permission once; only Online may open recovery settings.
    if (call.getBoolean("enableLocation", false)
        && getPermissionState("location") == PermissionState.DENIED) {
      startActivityForResult(
          call,
          new Intent(
              Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
              android.net.Uri.parse("package:" + getContext().getPackageName())),
          "settingsResult");
    } else requestPermissionForAlias("location", call, "permissionResult");
  }

  @PermissionCallback
  private void permissionResult(PluginCall call) {
    if (call.getBoolean("enableLocation", false)
        && preciseGranted()
        && !LocationAcquisition.enabled(
            (LocationManager) getContext().getSystemService(Context.LOCATION_SERVICE))) {
      startActivityForResult(
          call, new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS), "settingsResult");
    } else call.resolve(nativeStatus());
  }

  @ActivityCallback
  private void settingsResult(PluginCall call, ActivityResult result) {
    if (call != null) call.resolve(nativeStatus());
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
    getActivity()
        .runOnUiThread(
            () -> {
              if (!coarseGranted() && !preciseGranted()) {
                call.reject("Разрешите местоположение в настройках приложения.");
                return;
              }
              if (locationCall != null) {
                call.reject("Запрос местоположения уже выполняется.");
                return;
              }
              locationCall = call;
              locationRequestKey = call.getString("requestKey", "");
              long request = ++locationGeneration;
              acquisition = new LocationAcquisition(getContext(), timer);
              try {
                acquisition.once(
                    90000,
                    fix -> finishLocation(request, fix, null),
                    () ->
                        finishLocation(
                            request,
                            null,
                            "Местоположение временно недоступно. Повторите выход на линию."));
              } catch (SecurityException error) {
                finishLocation(request, null, "Разрешите местоположение в настройках приложения.");
              }
            });
  }

  @PluginMethod
  public void cancelLocation(PluginCall call) {
    getActivity()
        .runOnUiThread(
            () -> {
              if (call.getString("requestKey", "").equals(locationRequestKey))
                finishLocation(locationGeneration, null, "Запрос местоположения отменён.");
              call.resolve();
            });
  }

  private void finishLocation(long request, Location fix, String error) {
    if (request != locationGeneration || locationCall == null) return;
    ++locationGeneration;
    PluginCall call = locationCall;
    locationCall = null;
    locationRequestKey = null;
    timer.removeCallbacksAndMessages(null);
    if (acquisition != null) acquisition.stop();
    acquisition = null;
    if (error != null) call.reject(error);
    else {
      long age = LocationAcquisition.ageMs(fix);
      call.resolve(
          new JSObject()
              .put("lat", fix.getLatitude())
              .put("lng", fix.getLongitude())
              .put("accuracy", fix.getAccuracy())
              .put("ageMs", age)
              .put("timestamp", System.currentTimeMillis() - age));
    }
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
    if (!preciseGranted()) {
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
    finishLocation(locationGeneration, null, "Запрос GPS отменён.");
    super.handleOnDestroy();
  }
}
