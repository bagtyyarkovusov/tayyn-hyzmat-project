package io.openride.driver;

/**
 * One early location report per shift. The first usable fix queues one extra
 * report on the single shift worker instead of waiting for the next fixed-delay
 * tick; it is skipped if a scheduled report has already reached the server.
 */
final class FirstReportPolicy {
  private boolean queued, reported;
  /** True once per shift, for the first usable fix before any report succeeded. */
  synchronized boolean fixAccepted() {
    if (queued || reported) return false;
    return queued = true;
  }
  /** Checked on the worker when the queued report runs. */
  synchronized boolean stillNeeded() { return !reported; }
  /** A report reached the server; later fixes keep the normal cadence. */
  synchronized void reported() { reported = true; }
}
