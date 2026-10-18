package io.openride.driver;

import java.util.*;

/** One finite OS-owned order sound. IDs are opaque canonical attempts. */
public final class OrderAlertCoordinator {
  public interface Sink {
    void show(String id, long remainingMs);
    void cancel(String id);
    void schedule(Runnable expiry, long delayMs);
  }
  private final Sink sink;
  private String current;
  private long sequence;
  public OrderAlertCoordinator(Sink sink) { this.sink = sink; }
  public synchronized void show(String id, long remainingMs) {
    if (remainingMs <= 0 || id.equals(current)) return;
    stop(null);
    current = id;
    final long token = ++sequence;
    long duration = Math.min(20000, remainingMs);
    sink.show(id, duration);
    sink.schedule(() -> expire(id, token), duration);
  }
  private synchronized void expire(String id, long token) {
    if (token == sequence && id.equals(current)) stop(Collections.singleton(id));
  }
  public synchronized void stop(Set<String> ids) {
    if (current == null || (ids != null && !ids.contains(current))) return;
    String id = current;
    current = null;
    sequence++;
    sink.cancel(id);
  }
  public synchronized Set<String> snapshot() {
    return current == null ? Collections.emptySet() : Collections.singleton(current);
  }
  /** Candidates were captured before the request, so an old response cannot
   * clear an attempt verified after that request began. Failed requests must
   * never call this method. */
  public synchronized void reconcile(Set<String> canonical, Set<String> candidates) {
    if (current != null && candidates.contains(current) && !canonical.contains(current))
      stop(Collections.singleton(current));
  }
}
