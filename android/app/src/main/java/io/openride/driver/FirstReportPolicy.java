package io.openride.driver;

import java.util.concurrent.Executor;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

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

  /** Queues the early report for the first usable fix on the shift worker. */
  void fix(Executor worker, Runnable report) {
    if (fixAccepted())
      worker.execute(
          () -> {
            if (stillNeeded()) report.run();
          });
  }

  /**
   * Schedules the repeating report, then starts acquisition. The hardware path
   * delivers a cached fix synchronously inside {@code startAcquisition}; the
   * early report it queues must sit behind tick 0 on the single worker (equal
   * trigger times run in submission order) so a successful tick 0 skips it.
   */
  static ScheduledFuture<?> start(
      ScheduledExecutorService worker, Runnable tick, Runnable startAcquisition) {
    ScheduledFuture<?> repeating = worker.scheduleWithFixedDelay(tick, 0, 10, TimeUnit.SECONDS);
    startAcquisition.run();
    return repeating;
  }
}
