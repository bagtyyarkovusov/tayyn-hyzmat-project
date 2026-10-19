package io.openride.driver;

/**
 * A root-only double press. Handled navigation, overlays and pause reset it.
 * Each press asks the web shell once; that request settles exactly once, by the
 * web answer or by the native timeout, so a late answer cannot act again.
 */
public final class BackPressPolicy {
  private long first = -1;
  private long nextRequest, pending;
  public boolean root(long now) {
    if (first >= 0 && now >= first && now - first <= 2000) { reset(); return true; }
    first = now;
    return false;
  }
  /** Starts a web request, or returns 0 while an earlier one is unanswered. */
  public long request() {
    if (pending != 0) return 0;
    return pending = ++nextRequest;
  }
  /** True only for the first settlement of the pending request. */
  public boolean settle(long request) {
    if (request == 0 || pending != request) return false;
    pending = 0;
    return true;
  }
  public void reset() { first = -1; pending = 0; }
}
