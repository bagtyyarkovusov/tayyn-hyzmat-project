package io.openride.driver;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.location.*;
import android.os.*;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.*;
import java.util.concurrent.*;
import org.json.*;

/**
 * User-started location foreground service. Credentials deliberately never survive process death.
 */
public final class ShiftService extends Service {
  public static final String SHIFT_CHANNEL = "driver-shift",
      ORDER_CHANNEL = "driver-orders-v120",
      LEGACY_ORDER_CHANNEL = "driver-orders",
      CHAT_CHANNEL = "driver-chat";
  private static final int SHIFT_ID = 1;
  private static volatile ShiftService instance;
  private static volatile String phase = "off", detail = "";
  private static volatile long lastReportAt, lastFixAt, stopSequence;
  private static volatile double latitude, longitude, accuracy;
  private String apiBase, token;
  private static volatile String userId = "";
  private volatile boolean closing;
  private volatile long leaseDeadline;
  private final Handler main = new Handler(Looper.getMainLooper());
  private final ScheduledExecutorService worker = Executors.newSingleThreadScheduledExecutor();
  private LocationAcquisition acquisition;
  private static volatile long lastFixElapsedNanos;
  private volatile Location latest;
  private volatile FirstReportPolicy firstReport = new FirstReportPolicy();

  private void acceptLocation(Location fix) {
    if (closing || !LocationAcquisition.usable(fix)) return;
    latest = fix;
    lastFixElapsedNanos = fix.getElapsedRealtimeNanos();
    lastFixAt = System.currentTimeMillis() - LocationAcquisition.ageMs(fix);
    latitude = fix.getLatitude();
    longitude = fix.getLongitude();
    accuracy = fix.getAccuracy();
    // The single worker serialises this with scheduled reports.
    firstReport.fix(worker, this::tick);
  }

  public static void createChannels(Context context) {
    if (Build.VERSION.SDK_INT < 26) return;
    NotificationManager manager = context.getSystemService(NotificationManager.class);
    manager.createNotificationChannel(
        new NotificationChannel(
            SHIFT_CHANNEL, "Рабочая смена", NotificationManager.IMPORTANCE_LOW));
    if (manager.getNotificationChannel(ORDER_CHANNEL) == null) {
      NotificationChannel previous = manager.getNotificationChannel(LEGACY_ORDER_CHANNEL);
      NotificationChannel orders =
          new NotificationChannel(
              ORDER_CHANNEL,
              "Заказы",
              previous == null ? NotificationManager.IMPORTANCE_HIGH : previous.getImportance());
      android.net.Uri sound = orderSound(context);
      if (previous != null) {
        // Preserve OS opt-outs, silent/custom sounds and other channel choices.
        android.net.Uri selected = previous.getSound();
        if (selected == null
            || !android.provider.Settings.System.DEFAULT_NOTIFICATION_URI.equals(selected))
          sound = selected;
        orders.enableVibration(previous.shouldVibrate());
        orders.setVibrationPattern(previous.getVibrationPattern());
        orders.enableLights(previous.shouldShowLights());
        orders.setLightColor(previous.getLightColor());
        orders.setShowBadge(previous.canShowBadge());
        orders.setLockscreenVisibility(previous.getLockscreenVisibility());
      }
      orders.setSound(
          sound,
          new android.media.AudioAttributes.Builder()
              .setUsage(android.media.AudioAttributes.USAGE_NOTIFICATION)
              .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SONIFICATION)
              .build());
      manager.createNotificationChannel(orders);
    }
    manager.createNotificationChannel(
        new NotificationChannel(
            CHAT_CHANNEL, "Сообщения диспетчера", NotificationManager.IMPORTANCE_HIGH));
  }

  public static android.net.Uri orderSound(Context context) {
    return android.net.Uri.parse(
        "android.resource://" + context.getPackageName() + "/raw/offer_music_20s");
  }

  public static boolean channelEnabled(Context context, String id) {
    if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return false;
    if (Build.VERSION.SDK_INT < 26) return true;
    NotificationChannel channel =
        context.getSystemService(NotificationManager.class).getNotificationChannel(id);
    return channel != null && channel.getImportance() != NotificationManager.IMPORTANCE_NONE;
  }

  public static JSONObject status(Context context) {
    createChannels(context);
    JSONObject result = new JSONObject();
    ShiftService service = instance;
    try {
      result
          .put("running", instance != null)
          .put("userId", userId)
          .put("phase", phase)
          .put("detail", detail)
          .put("lastReportAt", lastReportAt)
          .put(
              "leaseRemainingMs",
              service == null
                  ? 0L
                  : Math.max(0L, service.leaseDeadline - SystemClock.elapsedRealtime()))
          .put("lastFixAt", lastFixAt)
          .put(
              "fixAgeMs",
              lastFixAt == 0
                  ? -1L
                  : Math.max(
                      0L,
                      TimeUnit.NANOSECONDS.toMillis(
                          SystemClock.elapsedRealtimeNanos() - lastFixElapsedNanos)))
          .put("stopSequence", stopSequence)
          .put("lat", latitude)
          .put("lng", longitude)
          .put("accuracy", accuracy)
          .put("ordersEnabled", channelEnabled(context, ORDER_CHANNEL))
          .put("chatEnabled", channelEnabled(context, CHAT_CHANNEL));
    } catch (JSONException ignored) {
    }
    return result;
  }

  public static void clear(String channel) {
    ShiftService service = instance;
    if (service != null) PushNotificationService.clear(service, channel);
  }

  static boolean ordersAllowed() {
    ShiftService service = instance;
    return service != null
        && !service.closing
        && SystemClock.elapsedRealtime() < service.leaseDeadline;
  }

  /** A shift is shutting down; this instance is about to be destroyed. */
  static boolean stopping() {
    ShiftService service = instance;
    return service != null && service.closing;
  }

  public static void end(Context context) {
    end(context, null);
  }

  public static void end(Context context, String expectedToken) {
    ShiftService service = instance;
    if (expectedToken != null && (service == null || !expectedToken.equals(service.token))) return;
    PushNotificationService.clear(context, "orders");
    if (service != null) service.finishShift("");
    else context.stopService(new Intent(context, ShiftService.class));
  }

  @Override
  public void onCreate() {
    super.onCreate();
    instance = this;
    createChannels(this);
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    if (!ShiftStartGate.adopts(
        intent != null && intent.getStringExtra("token") != null, token != null, closing)) {
      if (token == null) stopSelf();
      return START_NOT_STICKY;
    }
    apiBase = intent.getStringExtra("apiBase");
    token = intent.getStringExtra("token");
    userId = intent.getStringExtra("userId");
    latest = null;
    firstReport = new FirstReportPolicy();
    lastFixAt = 0;
    lastFixElapsedNanos = 0;
    lastReportAt = 0;
    leaseDeadline =
        SystemClock.elapsedRealtime() + Math.min(60000, intent.getLongExtra("leaseDurationMs", 0));
    phase = "connecting";
    detail = "";
    Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
    PendingIntent open =
        PendingIntent.getActivity(
            this, 0, launch, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    Notification notification =
        new NotificationCompat.Builder(this, SHIFT_CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_driver)
            .setContentTitle("Смена Tayyn Hyzmat")
            .setContentText("Откройте приложение, чтобы проверить GPS и связь")
            .setOngoing(true)
            .setContentIntent(open)
            .setOnlyAlertOnce(true)
            .build();
    try {
      if (Build.VERSION.SDK_INT >= 29)
        startForeground(
            SHIFT_ID,
            notification,
            android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
      else startForeground(SHIFT_ID, notification);
      if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION)
          != PackageManager.PERMISSION_GRANTED) throw new SecurityException("location");
      acquisition = new LocationAcquisition(this, main);
      FirstReportPolicy.start(worker, this::tick, () -> acquisition.start(this::acceptLocation));
    } catch (RuntimeException error) {
      finishShift("Разрешите точный GPS в настройках приложения.");
    }
    return START_NOT_STICKY;
  }

  private void tick() {
    if (closing) return;
    long now = System.currentTimeMillis();
    if (SystemClock.elapsedRealtime() >= leaseDeadline) {
      finishShift("Связь потеряна. Включите линию снова.");
      return;
    }
    Location fix = latest;
    if (!LocationAcquisition.usable(fix)) {
      phase = "gps-unavailable";
      PushNotificationService.clear(this, "orders");
      return;
    }
    try {
      JSONObject payload =
          new JSONObject()
              .put("lat", fix.getLatitude())
              .put("lng", fix.getLongitude())
              .put("accuracy", fix.getAccuracy())
              .put("recordedAt", iso(System.currentTimeMillis() - LocationAcquisition.ageMs(fix)));
      PushNotificationService.OrderSnapshot requestedOrders =
          PushNotificationService.orderSnapshot(this);
      long requestStarted = SystemClock.elapsedRealtime();
      JSONObject response = request("/native-shift/tick", payload);
      long requestElapsed = Math.max(0L, SystemClock.elapsedRealtime() - requestStarted);
      if (closing) return;
      long serverTime = parseIso(response.getString("serverTime"));
      leaseDeadline =
          SystemClock.elapsedRealtime()
              + NotificationDelivery.expiryFromServerTime(
                  parseIso(response.getString("leaseExpiresAt")), serverTime, 0L, requestElapsed);
      lastReportAt = System.currentTimeMillis();
      firstReport.reported();
      latitude = fix.getLatitude();
      longitude = fix.getLongitude();
      accuracy = fix.getAccuracy();
      phase = "online";
      detail = "";
      JSONArray raw = response.getJSONArray("events");
      List<NotificationInbox.Event> events = new ArrayList<>();
      for (int i = 0; i < raw.length(); i++) {
        JSONObject event = raw.getJSONObject(i);
        long expires =
            NotificationDelivery.expiryFromServerTime(
                parseIso(event.getString("expiresAt")),
                serverTime,
                System.currentTimeMillis(),
                requestElapsed);
        events.add(
            new NotificationInbox.Event(
                event.getString("id"),
                event.getString("channel"),
                event.getString("title"),
                event.getString("body"),
                expires));
      }
      if (PushNotificationService.configured(this)) {
        Set<String> canonicalOrders = new HashSet<>();
        for (NotificationInbox.Event event : events)
          if ("orders".equals(event.channel) && event.expiresAt > System.currentTimeMillis())
            canonicalOrders.add(event.id);
        PushNotificationService.reconcileOrders(this, canonicalOrders, requestedOrders);
        // Only this coordinator renders, even if registration is delayed.
        // A failed request never becomes an empty authoritative inbox.
        for (NotificationInbox.Event event : events)
          PushNotificationService.execute(() -> PushNotificationService.deliver(this, event.id));
      }
    } catch (RejectedShift error) {
      finishShift("Смена завершена сервером. Войдите или включите линию снова.");
    } catch (Exception error) {
      // A closing instance's late failure must not overwrite a newer shift's state.
      if (closing) return;
      phase = "reconnecting";
      detail = "Нет связи с диспетчером";
    }
  }

  private JSONObject request(String path, JSONObject payload) throws Exception {
    HttpURLConnection connection = (HttpURLConnection) new URL(apiBase + path).openConnection();
    try {
      connection.setConnectTimeout(8000);
      connection.setReadTimeout(8000);
      connection.setRequestMethod("POST");
      connection.setRequestProperty("Authorization", "Bearer " + token);
      connection.setRequestProperty("Content-Type", "application/json");
      connection.setDoOutput(true);
      connection.getOutputStream().write(payload.toString().getBytes(StandardCharsets.UTF_8));
      int status = connection.getResponseCode();
      if (status == 401 || status == 403 || status == 410) throw new RejectedShift();
      if (status < 200 || status >= 300) throw new IOException("API " + status);
      if (status == 204) return new JSONObject();
      try (InputStream input = connection.getInputStream();
          ByteArrayOutputStream output = new ByteArrayOutputStream()) {
        byte[] buffer = new byte[4096];
        int count;
        while ((count = input.read(buffer)) != -1) {
          if (output.size() + count > 262144) throw new IOException("oversize response");
          output.write(buffer, 0, count);
        }
        return new JSONObject(output.toString("UTF-8"));
      }
    } finally {
      connection.disconnect();
    }
  }

  private void finishShift(String reason) {
    if (closing) return;
    closing = true;
    phase = "off";
    detail = reason;
    stopSequence++;
    lastReportAt = 0;
    PushNotificationService.clear(this, "orders");
    worker.execute(
        () -> {
          try {
            if (token != null) request("/native-shift/stop", new JSONObject());
          } catch (Exception ignored) {
          } finally {
            token = null;
          }
        });
    main.post(
        () -> {
          if (acquisition != null) acquisition.stop();
          stopSelf();
        });
  }

  @Override
  public void onTaskRemoved(Intent rootIntent) {
    // Removing the task is not the driver's explicit Offline action. The
    // location foreground service keeps its server lease until stopped.
    super.onTaskRemoved(rootIntent);
  }

  @Override
  public void onDestroy() {
    if (!closing) finishShift("");
    if (acquisition != null) acquisition.stop();
    worker.shutdown();
    main.removeCallbacksAndMessages(null);
    PushNotificationService.clear(this, "orders");
    if (instance == this) instance = null;
    stopForeground(true);
    super.onDestroy();
  }

  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }

  private static String iso(long timestamp) {
    SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
    format.setTimeZone(TimeZone.getTimeZone("UTC"));
    return format.format(new Date(timestamp));
  }

  private static long parseIso(String timestamp) throws java.text.ParseException {
    SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
    format.setTimeZone(TimeZone.getTimeZone("UTC"));
    return format.parse(timestamp).getTime();
  }

  private static class RejectedShift extends IOException {}
}
