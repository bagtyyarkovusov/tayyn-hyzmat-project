package io.openride.driver;

import static org.junit.Assert.*;
import java.util.*;
import org.junit.Test;

/** Real coordinator, fake OS notification/scheduler boundary. */
public class OrderAlertCoordinatorTest {
  private final List<String> output = new ArrayList<>();
  private final List<Runnable> deadlines = new ArrayList<>();
  private final OrderAlertCoordinator coordinator = new OrderAlertCoordinator(new OrderAlertCoordinator.Sink() {
    public void show(String id, long remaining) { output.add("show:" + id + ":" + remaining); }
    public void cancel(String id) { output.add("cancel:" + id); }
    public void schedule(Runnable expiry, long delay) { deadlines.add(expiry); }
  });
  @Test public void fiveSecondsRemainingNeverStartsANewTwentySeconds() {
    coordinator.show("order:one:attempt-a", 5000);
    assertEquals(Arrays.asList("show:order:one:attempt-a:5000"), output);
    deadlines.get(0).run();
    assertEquals("cancel:order:one:attempt-a", output.get(1));
  }
  @Test public void cappedFiniteSoundAndExpiredVerification() {
    coordinator.show("too-late", 0);
    coordinator.show("long", 45000);
    assertEquals(Arrays.asList("show:long:20000"), output);
  }
  @Test public void replacementAndLateOldStopNeverSilenceReoffer() {
    coordinator.show("order:one:a", 20000);
    coordinator.show("order:one:b", 18000);
    coordinator.stop(Collections.singleton("order:one:a"));
    deadlines.get(0).run();
    assertEquals(Arrays.asList("show:order:one:a:20000", "cancel:order:one:a", "show:order:one:b:18000"), output);
    coordinator.stop(Collections.singleton("order:one:b"));
    assertEquals("cancel:order:one:b", output.get(3));
  }
  @Test public void canonicalEmptyCancelsButOldSnapshotCannotCancelNewerArrival() {
    coordinator.show("a", 20000);
    Set<String> requested = coordinator.snapshot();
    coordinator.show("b", 20000);
    coordinator.reconcile(Collections.emptySet(), requested);
    assertEquals(Collections.singleton("b"), coordinator.snapshot());
    coordinator.reconcile(Collections.emptySet(), coordinator.snapshot());
    assertTrue(coordinator.snapshot().isEmpty());
  }
  @Test public void repeatedCanonicalArrivalDoesNotExtendSound() {
    coordinator.show("a", 5000);
    coordinator.show("a", 20000);
    assertEquals(Arrays.asList("show:a:5000"), output);
    deadlines.get(0).run();
    assertTrue(coordinator.snapshot().isEmpty());
  }
  @Test public void logoutShiftLossAndSwipeUseSameExactStopBoundary() {
    coordinator.show("a", 20000);
    coordinator.stop(Collections.singleton("a"));
    coordinator.show("b", 20000);
    coordinator.stop(null);
    assertTrue(coordinator.snapshot().isEmpty());
    assertEquals(Arrays.asList("show:a:20000", "cancel:a", "show:b:20000", "cancel:b"), output);
  }
}
