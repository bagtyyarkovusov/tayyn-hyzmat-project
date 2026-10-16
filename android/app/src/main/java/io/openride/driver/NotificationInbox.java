package io.openride.driver;

import java.util.*;

/** Reconciles a server-owned canonical inbox; notification APIs are the external boundary. */
public final class NotificationInbox {
  public static final class Event {
    public final String id, channel, title, body;
    public final long expiresAt;

    public Event(String id, String channel, String title, String body, long expiresAt) {
      this.id = id;
      this.channel = channel;
      this.title = title;
      this.body = body;
      this.expiresAt = expiresAt;
    }
  }

  public interface Sink {
    void show(Event event);

    void cancel(String id);

    default void refresh(Event event) {}
  }

  private final Sink sink;
  private final Map<String, Event> displayed = new HashMap<>();
  private final Map<String, Long> seen = new HashMap<>();

  public NotificationInbox(Sink sink) {
    this.sink = sink;
  }

  public synchronized void reconcile(List<Event> events, long now) {
    Set<String> current = new HashSet<>();
    for (String id : new ArrayList<>(seen.keySet())) if (seen.get(id) <= now) seen.remove(id);
    for (Event event : events) {
      if (event.expiresAt <= now) continue;
      current.add(event.id);
      if (!seen.containsKey(event.id)) {
        displayed.put(event.id, event);
        sink.show(event);
      } else if (displayed.containsKey(event.id)) {
        displayed.put(event.id, event);
        sink.refresh(event);
      }
      seen.put(event.id, event.expiresAt);
    }
    for (String id : new ArrayList<>(displayed.keySet())) {
      if (!current.contains(id)) {
        displayed.remove(id);
        sink.cancel(id);
      }
    }
  }

  public synchronized void clear(String channel) {
    for (Event event : new ArrayList<>(displayed.values())) {
      if (event.channel.equals(channel)) {
        displayed.remove(event.id);
        sink.cancel(event.id);
      }
    }
  }

  public synchronized void stop() {
    for (String id : displayed.keySet()) sink.cancel(id);
    displayed.clear();
    seen.clear();
  }
}
