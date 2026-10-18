package io.openride.driver;

import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import org.json.*;

/**
 * FCM is only a wake-up transport. The Railway endpoint revalidates the event
 * against the signed installation before this class posts anything.
 */
public final class PushNotificationService extends FirebaseMessagingService {
  static final String PREFS = "driver-notifications";
  static final String API = "apiBase", CAPABILITY = "notificationToken", TOKEN = "fcmToken";

  static SharedPreferences prefs(Context context) {
    return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
  }

  private static final Object DELIVERY_LOCK = new Object();
  private static final Object STATE_LOCK = new Object();
  private static long configurationVersion;
  private static final java.util.concurrent.ExecutorService EXECUTOR = java.util.concurrent.Executors.newSingleThreadExecutor();

  private static OrderAlertCoordinator orderCoordinator;
  private static JSONObject activeOrderEvent;
  private static long activeOrderVerifiedAt;
  private static final android.os.Handler DEADLINES = new android.os.Handler(android.os.Looper.getMainLooper());
  private static OrderAlertCoordinator orders(Context context) {
    if (orderCoordinator == null) {
      Context app = context.getApplicationContext();
      orderCoordinator = new OrderAlertCoordinator(new OrderAlertCoordinator.Sink() {
        public void show(String id, long remaining) {
          PushNotificationService.show(app, activeOrderEvent, "orders", id, System.currentTimeMillis() + remaining, activeOrderVerifiedAt);
        }
        public void cancel(String id) {
          NotificationManagerCompat.from(app).cancel(id, 0);
          Set<String> ids = new HashSet<>(prefs(app).getStringSet("displayed:orders", Collections.emptySet()));
          ids.remove(id);
          prefs(app).edit().putStringSet("displayed:orders", ids).remove("verified:" + id).apply();
        }
        public void schedule(Runnable expiry, long delay) { DEADLINES.postDelayed(() -> { synchronized (STATE_LOCK) { expiry.run(); } }, delay); }
      });
    }
    return orderCoordinator;
  }
  static final class OrderSnapshot {
    final long version;
    final Set<String> ids;
    OrderSnapshot(long version, Set<String> ids) { this.version = version; this.ids = ids; }
  }
  static OrderSnapshot orderSnapshot(Context context) {
    synchronized (STATE_LOCK) {
      return new OrderSnapshot(configurationVersion,
          new HashSet<>(prefs(context).getStringSet("displayed:orders", Collections.emptySet())));
    }
  }
  static void reconcileOrders(Context context, Set<String> canonical, OrderSnapshot requested) {
    synchronized (STATE_LOCK) {
      if (requested.version != configurationVersion) return;
      orders(context).reconcile(canonical, requested.ids);
      Set<String> vanished = new HashSet<>(requested.ids);
      vanished.removeAll(canonical);
      // Includes rows restored after process death; NotificationManager's own
      // timeout still bounds their finite sound when this process is asleep.
      clear(context, "orders", vanished);
    }
  }
  static void reconcileOrdersAtServerTime(Context context, Set<String> canonical, long serverTime) {
    synchronized (STATE_LOCK) {
      OrderSnapshot current = orderSnapshot(context);
      Set<String> candidates = new HashSet<>();
      for (String id : current.ids)
        if (prefs(context).getLong("verified:" + id, 0) <= serverTime) candidates.add(id);
      reconcileOrders(context, canonical, new OrderSnapshot(current.version, candidates));
    }
  }
  static void opened(Context context, Intent intent) {
    String id = intent == null ? null : intent.getStringExtra("notificationEventId");
    if (id != null) clear(context, intent.getStringExtra("notificationChannel"), Collections.singleton(id));
  }

  static void execute(Runnable task) { EXECUTOR.execute(task); }
  static void updateToken(Context context, String token) {
    prefs(context).edit().putString(TOKEN, token).apply();
    uploadToken(context, token);
    DriverNotificationsPlugin.tokenChanged();
  }
  static void configure(Context context, String api, String capability, String userId, String deviceId) {
    synchronized (STATE_LOCK) {
      SharedPreferences p = prefs(context);
      if (!userId.equals(p.getString("userId", "")) || !deviceId.equals(p.getString("deviceId", ""))) reset(context);
      configurationVersion++;
      p.edit().putString(API, api).putString(CAPABILITY, capability).putString("userId", userId).putString("deviceId", deviceId).remove("enabled").apply();
    }
    uploadToken(context, prefs(context).getString(TOKEN, ""));
  }
  static boolean configured(Context context) { return !prefs(context).getString(CAPABILITY, "").trim().isEmpty(); }
  private static void uploadToken(Context context, String token) {
    if (token == null || token.trim().isEmpty()) return;
    SharedPreferences p = prefs(context); String api = p.getString(API, ""), capability = p.getString(CAPABILITY, "");
    if (api.trim().isEmpty() || capability.trim().isEmpty()) return;
    execute(() -> { try { post(api + "/native-notifications/token", capability, new JSONObject().put("token", token)); } catch (Exception ignored) {} });
  }
  static void setPresence(boolean chatVisible, boolean foreground) {
    // Process-local presence cannot remain foreground after process death.
    processChatVisible = chatVisible; processForeground = foreground;
  }
  private static volatile boolean processChatVisible, processForeground;
  static void clear(Context context, String channel) { clear(context, channel, null); }
  static void clear(Context context, String channel, Set<String> eventIds) {
    synchronized (STATE_LOCK) {
      if ("orders".equals(channel)) {
        if (eventIds == null) configurationVersion++;
        else {
          deliveryPolicy(prefs(context)).dismiss(eventIds, System.currentTimeMillis());
        }
        orders(context).stop(eventIds);
      }
      NotificationManagerCompat manager = NotificationManagerCompat.from(context);
    // IDs are event IDs; only the Android channel's active rows are cleared,
    // leaving the persistent foreground-shift notification untouched.
    Set<String> ids = new HashSet<>(prefs(context).getStringSet("displayed:" + channel, Collections.emptySet()));
    for (Iterator<String> it = ids.iterator(); it.hasNext();) {
      String id = it.next();
      if (eventIds == null || eventIds.contains(id)) {
        manager.cancel(id, 0);
        prefs(context).edit().remove("verified:" + id).apply();
        it.remove();
      }
    }
    prefs(context).edit().putStringSet("displayed:" + channel, ids).apply();
    }
  }
  static void reset(Context context) {
    synchronized (STATE_LOCK) {
      configurationVersion++;
      clear(context, "chat"); clear(context, "orders");
      String fcm = prefs(context).getString(TOKEN, "");
      prefs(context).edit().clear().putString(TOKEN, fcm).apply();
      setPresence(false, false);
    }
  }

  @Override public void onNewToken(String token) {
    updateToken(this, token);
    // The WebView/native plugin uploads this token through the authenticated
    // registration endpoint. FCM never receives the access token here.
  }

  @Override public void onMessageReceived(RemoteMessage message) {
    String eventId = message.getData().get("eventId");
    if (eventId == null || eventId.trim().isEmpty()) return;
    deliver(this, eventId);
  }

  static void deliver(Context context, String eventId) {
    synchronized (DELIVERY_LOCK) { deliverLocked(context, eventId); }
  }

  private static void deliverLocked(Context context, String eventId) {
    SharedPreferences p = prefs(context);
    final String api, capability;
    final long version;
    synchronized (STATE_LOCK) {
      api = p.getString(API, ""); capability = p.getString(CAPABILITY, ""); version = configurationVersion;
    }
    if (api.trim().isEmpty() || capability.trim().isEmpty()) return;
    try {
      long requestStarted = android.os.SystemClock.elapsedRealtime();
      JSONObject response = post(api + "/native-notifications/event", capability,
          new JSONObject().put("eventId", eventId));
      long requestElapsed = Math.max(0L, android.os.SystemClock.elapsedRealtime() - requestStarted);
      JSONObject event = response.optJSONObject("event");
      if (event == null) {
        synchronized (STATE_LOCK) {
          if (version != configurationVersion) return;
          clear(context, "orders", Collections.singleton(eventId));
          clear(context, "chat", Collections.singleton(eventId));
        }
        return;
      }
      String id = event.optString("id", eventId);
      if (!eventId.equals(id)) return;
      String channel = event.optString("channel", "chat");
      long now = System.currentTimeMillis();
      long serverNow = parseIso(response.optString("serverTime", ""));
      long serverExpiry = parseIso(event.optString("expiresAt", ""));
      long expires = NotificationDelivery.expiryFromServerTime(serverExpiry, serverNow, now, requestElapsed);
      // Sound uses a monotonic deadline even if device wall time changes.
      long soundDeadline = requestStarted + (serverExpiry - serverNow);

      // Do not let an account switch during the request display the old
      // account's preview. The opaque capability is installation-scoped.
      synchronized (STATE_LOCK) {
        if (version != configurationVersion || !capability.equals(p.getString(CAPABILITY, "")) || !api.equals(p.getString(API, ""))) return;
        if ("orders".equals(channel) && !ShiftService.ordersAllowed()) return;
        now = System.currentTimeMillis();
        boolean visible = processForeground && processChatVisible;
        boolean display = deliveryPolicy(p).shouldDisplay(id, channel, expires, now, visible);
        if (display) {
          if ("orders".equals(channel)) {
            activeOrderEvent = event;
            activeOrderVerifiedAt = serverNow;
            orders(context).show(id, soundDeadline - android.os.SystemClock.elapsedRealtime());
          } else show(context, event, channel, id, expires, serverNow);
        }
      }
      ack(api, capability, id);
    } catch (Exception ignored) {
      // Leave this event unacknowledged. The durable server outbox retries
      // its same ID after transport acceptance until canonical recovery or
      // expiry; no unverified payload is ever displayed.
    }
  }

  private static NotificationDelivery deliveryPolicy(SharedPreferences p) {
    NotificationDelivery.Store store = new NotificationDelivery.Store() {
        public Map<String, Long> load() {
          Map<String, Long> out = new HashMap<>();
          for (Map.Entry<String, ?> e : p.getAll().entrySet())
            if (e.getKey().startsWith("seen:")) out.put(e.getKey().substring(5), ((Number) e.getValue()).longValue());
          return out;
        }
        public void save(Map<String, Long> next) {
          SharedPreferences.Editor e = p.edit();
          for (String key : p.getAll().keySet()) if (key.startsWith("seen:")) e.remove(key);
          for (Map.Entry<String, Long> item : next.entrySet()) e.putLong("seen:" + item.getKey(), item.getValue());
          e.apply();
        }
      };
    return new NotificationDelivery(store);
  }

  private static void show(Context context, JSONObject event, String channel, String id, long expires, long verifiedAt) {
    if (android.os.Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return;
    ShiftService.createChannels(context);
    String channelId = "orders".equals(channel) ? ShiftService.ORDER_CHANNEL : ShiftService.CHAT_CHANNEL;
    Intent launch = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
    if (launch == null || !ShiftService.channelEnabled(context, channelId)) return;
    launch.putExtra("notificationChannel", channel).putExtra("notificationEventId", id)
        .setData(android.net.Uri.parse("tayyn://notification/" + android.net.Uri.encode(id)));
    Intent dismissed = new Intent(context, NotificationDismissReceiver.class)
        .setData(android.net.Uri.parse("tayyn://dismiss/" + android.net.Uri.encode(id)))
        .putExtra("eventId", id).putExtra("channel", channel);
    PendingIntent delete = PendingIntent.getBroadcast(context, 0, dismissed,
        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    PendingIntent open = PendingIntent.getActivity(context, id.hashCode(), launch,
        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    Notification notification = new NotificationCompat.Builder(context, channelId)
        .setSmallIcon(R.drawable.ic_stat_driver)
        .setContentTitle(event.optString("title", "Tayyn Hyzmat"))
        .setContentText(event.optString("body", ""))
        .setStyle(new NotificationCompat.BigTextStyle().bigText(event.optString("body", "")))
        .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
        .setAutoCancel(true).setOnlyAlertOnce(true).setContentIntent(open).setDeleteIntent(delete)
        .setPriority(NotificationCompat.PRIORITY_HIGH)
        .setSound("orders".equals(channel) ? ShiftService.orderSound(context) : android.provider.Settings.System.DEFAULT_NOTIFICATION_URI)
        .setTimeoutAfter(Math.max(1, expires - System.currentTimeMillis())).build();
    NotificationManagerCompat.from(context).notify(id, 0, notification);
    Set<String> ids = new HashSet<>(prefs(context).getStringSet("displayed:" + channel, Collections.emptySet()));
    ids.add(id);
    prefs(context).edit().putStringSet("displayed:" + channel, ids).putLong("verified:" + id, verifiedAt).apply();
  }

  private static JSONObject post(String endpoint, String bearer, JSONObject body) throws Exception {
    HttpURLConnection c = (HttpURLConnection) new URL(endpoint).openConnection();
    try {
      c.setConnectTimeout(7000); c.setReadTimeout(7000); c.setRequestMethod("POST"); c.setDoOutput(true);
      c.setRequestProperty("Authorization", "Bearer " + bearer); c.setRequestProperty("Content-Type", "application/json");
      c.getOutputStream().write(body.toString().getBytes(StandardCharsets.UTF_8));
      int responseCode = c.getResponseCode();
      if (responseCode == 401 || responseCode == 403) {
        throw new IOException("notification capability revoked");
      }
      if (responseCode < 200 || responseCode >= 300) throw new IOException("HTTP " + responseCode);
      if (responseCode == 204) return new JSONObject();
      try (InputStream in = c.getInputStream(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
        byte[] buffer = new byte[4096]; int n; while ((n = in.read(buffer)) != -1) {
          if (out.size() + n > 262144) throw new IOException("oversize response");
          out.write(buffer, 0, n);
        }
        return new JSONObject(out.toString("UTF-8"));
      }
    } finally { c.disconnect(); }
  }
  private static void ack(String api, String capability, String id) {
    try { post(api + "/native-notifications/ack", capability, new JSONObject().put("eventId", id)); } catch (Exception ignored) {}
  }
  static long parseIso(String value) throws Exception {
    java.text.SimpleDateFormat format = new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
    format.setTimeZone(TimeZone.getTimeZone("UTC"));
    return format.parse(value).getTime();
  }
}
