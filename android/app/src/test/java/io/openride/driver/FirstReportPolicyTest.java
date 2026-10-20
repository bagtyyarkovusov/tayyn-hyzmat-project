package io.openride.driver;

import static org.junit.Assert.*;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Test;

public class FirstReportPolicyTest {
  @Test public void firstFixBeforeAnyReportQueuesOneEarlyReport() {
    FirstReportPolicy first = new FirstReportPolicy();
    assertTrue(first.fixAccepted());
    assertTrue(first.stillNeeded());
    assertFalse(first.fixAccepted());
    assertFalse(first.fixAccepted());
  }
  @Test public void failedEarlyReportIsNotRepeatedByLaterFixes() {
    FirstReportPolicy first = new FirstReportPolicy();
    List<Runnable> queued = new ArrayList<>();
    int[] requests = {0};
    // The early report runs, but its request fails, so reported() is never called.
    first.fix(queued::add, () -> requests[0]++);
    assertEquals(1, queued.size());
    queued.remove(0).run();
    assertEquals(1, requests[0]);
    // Later fixes do not queue another early report; the 10 s cadence takes over.
    first.fix(queued::add, () -> requests[0]++);
    first.fix(queued::add, () -> requests[0]++);
    assertTrue(queued.isEmpty());
    assertTrue(first.stillNeeded());
    // The next scheduled tick may still report and settle the policy.
    first.reported();
    assertFalse(first.stillNeeded());
    first.fix(queued::add, () -> requests[0]++);
    assertTrue(queued.isEmpty());
  }
  @Test public void cachedFixDeliveredDuringStartDoesNotDuplicateTickZero() throws Exception {
    // Plain hardware acquisition delivers a cached fix synchronously from start().
    ScheduledExecutorService worker = Executors.newSingleThreadScheduledExecutor();
    try {
      FirstReportPolicy first = new FirstReportPolicy();
      AtomicInteger requests = new AtomicInteger();
      Runnable tick =
          () -> {
            requests.incrementAndGet();
            first.reported();
          };
      ScheduledFuture<?> repeating =
          FirstReportPolicy.start(worker, tick, () -> first.fix(worker, tick));
      // Runs after both tick 0 and any early report already queued.
      worker.submit(() -> {}).get(5, TimeUnit.SECONDS);
      repeating.cancel(false);
      assertEquals(1, requests.get());
    } finally {
      worker.shutdownNow();
    }
  }
  @Test public void scheduledReportThatAlreadySucceededSkipsQueuedEarlyReport() {
    FirstReportPolicy first = new FirstReportPolicy();
    assertTrue(first.fixAccepted());
    first.reported();
    assertFalse(first.stillNeeded());
  }
  @Test public void fixAfterSuccessfulReportKeepsNormalCadence() {
    FirstReportPolicy first = new FirstReportPolicy();
    first.reported();
    assertFalse(first.fixAccepted());
  }
  @Test public void newShiftCanReportEarlyAgain() {
    FirstReportPolicy previous = new FirstReportPolicy();
    assertTrue(previous.fixAccepted());
    previous.reported();
    FirstReportPolicy next = new FirstReportPolicy();
    assertTrue(next.fixAccepted());
    assertTrue(next.stillNeeded());
  }
}
