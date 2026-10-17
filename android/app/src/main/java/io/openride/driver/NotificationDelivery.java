package io.openride.driver;

import java.util.Map;
import java.util.Iterator;

/** Device notification policy shared by Socket.IO, shift polling and FCM. */
public final class NotificationDelivery {
  public interface Store {
    Map<String, Long> load();
    void save(Map<String, Long> seen);
  }
  private final Store store;
  public NotificationDelivery(Store store) { this.store = store; }

  /**
   * Convert an expiry expressed in server wall-clock time to the device wall
   * clock, conservatively subtracting the request round trip. A slow response
   * must never extend a short-lived offer on the device.
   */
  static long expiryFromServerTime(long eventExpiresAt, long serverNow,
      long localNow, long requestElapsedMs) {
    long elapsed = Math.max(0L, requestElapsedMs);
    long remaining = eventExpiresAt - serverNow - elapsed;
    return localNow + remaining;
  }

  /** Canonical events may be acknowledged silently when chat is visible or alerts are muted. */
  public synchronized boolean shouldDisplay(String id, String channel, long expiresAt, long now,
      boolean enabled, boolean chatVisible) {
    Map<String, Long> seen = store.load();
    for (Iterator<Map.Entry<String, Long>> it = seen.entrySet().iterator(); it.hasNext();)
      if (it.next().getValue() <= now) it.remove();
    boolean unseen = !seen.containsKey(id);
    if (expiresAt > now) seen.put(id, expiresAt);
    store.save(seen);
    return unseen && expiresAt > now && enabled && !("chat".equals(channel) && chatVisible);
  }
}
