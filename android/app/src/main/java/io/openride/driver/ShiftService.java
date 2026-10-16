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
      ORDER_CHANNEL = "driver-orders",
      CHAT_CHANNEL = "driver-chat";
  private static final int SHIFT_ID = 1;
  private static volatile ShiftService instance;
  private static volatile String phase = "off", detail = "";
  private static volatile long lastReportAt, stopSequence;
  private static volatile double latitude, longitude, accuracy;
  private String apiBase, token;
  private static volatile String userId = "";
  private volatile boolean closing;
  private long leaseDeadline;
  private final Handler main = new Handler(Looper.getMainLooper());
  private final ScheduledExecutorService worker = Executors.newSingleThreadScheduledExecutor();
  private LocationManager locations;
  private volatile Location latest;
  private NotificationInbox inbox;
  private final LocationListener listener =
      new LocationListener() {
        @Override
        public void onLocationChanged(Location location) {
          latest = location;
        }

        @Override
        public void onProviderDisabled(String provider) {
          phase = "gps-unavailable";
        }

        @Override
        public void onProviderEnabled(String provider) {}

        @Override
        public void onStatusChanged(String provider, int status, Bundle extras) {}
      };

  public static void createChannels(Context context) {
    if (Build.VERSION.SDK_INT < 26) return;
    NotificationManager manager = context.getSystemService(NotificationManager.class);
    manager.createNotificationChannel(
        new NotificationChannel(
            SHIFT_CHANNEL, "Рабочая смена", NotificationManager.IMPORTANCE_LOW));
    manager.createNotificationChannel(
        new NotificationChannel(ORDER_CHANNEL, "Заказы", NotificationManager.IMPORTANCE_HIGH));
    manager.createNotificationChannel(
        new NotificationChannel(
            CHAT_CHANNEL, "Сообщения диспетчера", NotificationManager.IMPORTANCE_HIGH));
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
    try {
      result
          .put("running", instance != null)
          .put("userId", userId)
          .put("phase", phase)
          .put("detail", detail)
          .put("lastReportAt", lastReportAt)
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
    if (service != null && service.inbox != null) service.inbox.clear(channel);
  }

  public static void end(Context context) {
    end(context, null);
  }

  public static void end(Context context, String expectedToken) {
    ShiftService service = instance;
    if (expectedToken != null && (service == null || !expectedToken.equals(service.token))) return;
    if (service != null) service.finishShift("");
    else context.stopService(new Intent(context, ShiftService.class));
  }

  @Override
  public void onCreate() {
    super.onCreate();
    instance = this;
    createChannels(this);
    inbox =
        new NotificationInbox(
            new NotificationInbox.Sink() {
              public void show(NotificationInbox.Event event) {
                if (closing
                    || !channelEnabled(
                        ShiftService.this,
                        event.channel.equals("orders") ? ORDER_CHANNEL : CHAT_CHANNEL)) return;
                Intent intent = getPackageManager().getLaunchIntentForPackage(getPackageName());
                intent.putExtra("notificationChannel", event.channel);
                PendingIntent open =
                    PendingIntent.getActivity(
                        ShiftService.this,
                        event.channel.hashCode(),
                        intent,
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
                NotificationCompat.Builder notification =
                    new NotificationCompat.Builder(
                            ShiftService.this,
                            event.channel.equals("orders") ? ORDER_CHANNEL : CHAT_CHANNEL)
                        .setSmallIcon(R.drawable.ic_stat_driver)
                        .setContentTitle(event.title)
                        .setContentText(event.body)
                        .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                        .setAutoCancel(true)
                        .setOnlyAlertOnce(true)
                        .setContentIntent(open)
                        .setTimeoutAfter(Math.max(1, event.expiresAt - System.currentTimeMillis()));
                if (ContextCompat.checkSelfPermission(
                            ShiftService.this, Manifest.permission.POST_NOTIFICATIONS)
                        == PackageManager.PERMISSION_GRANTED
                    || Build.VERSION.SDK_INT < 33)
                  NotificationManagerCompat.from(ShiftService.this)
                      .notify(event.id, 0, notification.build());
              }

              public void refresh(NotificationInbox.Event event) {
                show(event);
              }

              public void cancel(String id) {
                NotificationManagerCompat.from(ShiftService.this).cancel(id, 0);
              }
            });
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    if (intent == null || intent.getStringExtra("token") == null || token != null) {
      if (token == null) stopSelf();
      return START_NOT_STICKY;
    }
    apiBase = intent.getStringExtra("apiBase");
    token = intent.getStringExtra("token");
    userId = intent.getStringExtra("userId");
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
      locations = (LocationManager) getSystemService(LOCATION_SERVICE);
      if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION)
          != PackageManager.PERMISSION_GRANTED) throw new SecurityException("location");
      locations.requestLocationUpdates(
          LocationManager.GPS_PROVIDER, 10000, 0, listener, Looper.getMainLooper());
      if (locations.isProviderEnabled(LocationManager.NETWORK_PROVIDER))
        locations.requestLocationUpdates(
            LocationManager.NETWORK_PROVIDER, 10000, 0, listener, Looper.getMainLooper());
      worker.scheduleWithFixedDelay(this::tick, 0, 10, TimeUnit.SECONDS);
    } catch (RuntimeException error) {
      finishShift("Разрешите точный GPS и уведомления в настройках приложения.");
    }
    return START_NOT_STICKY;
  }

  private void requestFreshLocation() {
    main.post(
        () -> {
          if (closing || locations == null) return;
          try {
            if (Build.VERSION.SDK_INT >= 30)
              locations.getCurrentLocation(
                  LocationManager.GPS_PROVIDER,
                  null,
                  getMainExecutor(),
                  location -> {
                    if (location != null) latest = location;
                  });
            else
              locations.requestSingleUpdate(
                  LocationManager.GPS_PROVIDER, listener, Looper.getMainLooper());
          } catch (SecurityException error) {
            finishShift("Доступ к GPS отозван. Смена завершена.");
          }
        });
  }

  private void tick() {
    if (closing) return;
    long now = System.currentTimeMillis();
    if (SystemClock.elapsedRealtime() >= leaseDeadline) {
      finishShift("Связь потеряна. Включите линию снова.");
      return;
    }
    if (!channelEnabled(this, ORDER_CHANNEL) || !channelEnabled(this, CHAT_CHANNEL)) {
      finishShift("Включите уведомления о заказах и сообщениях в настройках.");
      return;
    }
    requestFreshLocation();
    Location fix = latest;
    if (fix == null
        || SystemClock.elapsedRealtimeNanos() - fix.getElapsedRealtimeNanos()
            > TimeUnit.SECONDS.toNanos(30)) {
      phase = "gps-unavailable";
      return;
    }
    try {
      JSONObject payload =
          new JSONObject()
              .put("lat", fix.getLatitude())
              .put("lng", fix.getLongitude())
              .put("accuracy", fix.getAccuracy())
              .put("recordedAt", iso(fix.getTime()));
      JSONObject response = request("/native-shift/tick", payload);
      if (closing) return;
      long serverTime = parseIso(response.getString("serverTime"));
      leaseDeadline =
          SystemClock.elapsedRealtime()
              + parseIso(response.getString("leaseExpiresAt"))
              - serverTime;
      lastReportAt = System.currentTimeMillis();
      latitude = fix.getLatitude();
      longitude = fix.getLongitude();
      accuracy = fix.getAccuracy();
      phase = "online";
      detail = "";
      JSONArray raw = response.getJSONArray("events");
      List<NotificationInbox.Event> events = new ArrayList<>();
      for (int i = 0; i < raw.length(); i++) {
        JSONObject event = raw.getJSONObject(i);
        long expires = now + parseIso(event.getString("expiresAt")) - serverTime;
        events.add(
            new NotificationInbox.Event(
                event.getString("id"),
                event.getString("channel"),
                event.getString("title"),
                event.getString("body"),
                expires));
      }
      inbox.reconcile(events, now);
    } catch (RejectedShift error) {
      finishShift("Смена завершена сервером. Войдите или включите линию снова.");
    } catch (Exception error) {
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
    if (inbox != null) inbox.stop();
    worker.execute(
        () -> {
          try {
            if (token != null) request("/native-shift/stop", new JSONObject());
          } catch (Exception ignored) {
          } finally {
            token = null;
          }
        });
    main.post(this::stopSelf);
  }

  @Override
  public void onTaskRemoved(Intent rootIntent) {
    finishShift("");
    super.onTaskRemoved(rootIntent);
  }

  @Override
  public void onDestroy() {
    if (!closing) finishShift("");
    if (locations != null) locations.removeUpdates(listener);
    worker.shutdown();
    main.removeCallbacksAndMessages(null);
    if (inbox != null) inbox.stop();
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
