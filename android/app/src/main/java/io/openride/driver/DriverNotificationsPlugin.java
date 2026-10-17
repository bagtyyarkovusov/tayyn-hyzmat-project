package io.openride.driver;

import android.Manifest;
import android.content.*;
import android.content.pm.PackageManager;
import android.os.Build;
import androidx.core.content.ContextCompat;
import com.getcapacitor.*;
import com.getcapacitor.annotation.*;
import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessaging;
import java.net.URI;

/** Native notification settings belong to an authenticated installation, not a shift. */
@CapacitorPlugin(name = "DriverNotifications", permissions = {
  @Permission(alias = "notifications", strings = {Manifest.permission.POST_NOTIFICATIONS})
})
public final class DriverNotificationsPlugin extends Plugin {
  private static volatile DriverNotificationsPlugin instance;
  private boolean firebaseConfigured;

  @Override public void load() {
    instance = this;
    ShiftService.createChannels(getContext());
    PushNotificationService.setPresence(false, false);
    try {
      firebaseConfigured = FirebaseApp.initializeApp(getContext()) != null;
      if (firebaseConfigured) FirebaseMessaging.getInstance().getToken().addOnSuccessListener(token ->
          PushNotificationService.updateToken(getContext(), token));
    } catch (RuntimeException ignored) { firebaseConfigured = false; }
  }

  static void tokenChanged() {
    DriverNotificationsPlugin current = instance;
    if (current != null) current.notifyListeners("tokenChanged", new JSObject(), true);
  }

  private JSObject nativeStatus() {
    SharedPreferences p = PushNotificationService.prefs(getContext());
    String permission = "granted";
    if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
      permission = getPermissionState("notifications") == PermissionState.PROMPT ? "prompt" : "denied";
    if ("granted".equals(permission) && (!ShiftService.channelEnabled(getContext(), ShiftService.ORDER_CHANNEL) || !ShiftService.channelEnabled(getContext(), ShiftService.CHAT_CHANNEL))) permission = "denied";
    return new JSObject().put("permission", permission)
        .put("enabled", p.getBoolean(PushNotificationService.ENABLED, true))
        .put("configured", firebaseConfigured)
        .put("token", p.getString(PushNotificationService.TOKEN, ""));
  }
  @PluginMethod public void status(PluginCall call) { call.resolve(nativeStatus()); }
  @PluginMethod public void requestPermissions(PluginCall call) {
    if (Build.VERSION.SDK_INT < 33) { call.resolve(nativeStatus()); return; }
    requestPermissionForAlias("notifications", call, "notificationPermissionResult");
  }
  @PermissionCallback private void notificationPermissionResult(PluginCall call) { call.resolve(nativeStatus()); }
  @PluginMethod public void configure(PluginCall call) {
    String api = call.getString("apiBase", "").replaceAll("/+$", "");
    String capability = call.getString("notificationToken", "");
    String userId = call.getString("userId", ""), deviceId = call.getString("deviceId", "");
    try {
      URI uri = new URI(api);
      if (!"https".equals(uri.getScheme()) || uri.getHost() == null || uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null || capability.length() < 32 || userId.isEmpty() || deviceId.isEmpty()) throw new Exception();
    } catch (Exception error) { call.reject("Для уведомлений требуется защищённый HTTPS API и подтверждённый вход."); return; }
    PushNotificationService.configure(getContext(), api, capability, userId, deviceId, call.getBoolean("enabled", true));
    call.resolve();
  }
  @PluginMethod public void setEnabled(PluginCall call) {
    PushNotificationService.setEnabled(getContext(), call.getBoolean("enabled", true)); call.resolve();
  }
  @PluginMethod public void setPresence(PluginCall call) {
    PushNotificationService.setPresence(call.getBoolean("chatVisible", false), call.getBoolean("foreground", true)); call.resolve();
  }
  @PluginMethod public void deliver(PluginCall call) {
    String eventId = call.getString("eventId", "");
    if (eventId.trim().isEmpty() || eventId.length() > 250) { call.reject("Нет идентификатора события."); return; }
    PushNotificationService.execute(() -> { PushNotificationService.deliver(getContext(), eventId); call.resolve(); });
  }
  @PluginMethod public void clear(PluginCall call) {
    JSArray eventIds = call.getArray("eventIds");
    java.util.Set<String> selected = null;
    if (eventIds != null) {
      selected = new java.util.HashSet<>();
      for (int i = 0; i < eventIds.length(); i++) {
        Object value = eventIds.opt(i);
        if (value instanceof String) selected.add((String) value);
      }
    }
    PushNotificationService.clear(getContext(), call.getString("channel", "chat"), selected); call.resolve();
  }
  @PluginMethod public void reset(PluginCall call) { PushNotificationService.reset(getContext()); call.resolve(); }
  @PluginMethod public void settings(PluginCall call) {
    Intent intent = Build.VERSION.SDK_INT >= 26 ? new Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, getContext().getPackageName()) : new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, android.net.Uri.parse("package:" + getContext().getPackageName()));
    getActivity().startActivity(intent); call.resolve();
  }
  @Override protected void handleOnPause() { PushNotificationService.setPresence(false, false); }
  @Override protected void handleOnDestroy() {
    if (instance == this) instance = null;
    PushNotificationService.setPresence(false, false);
    super.handleOnDestroy();
  }
}
