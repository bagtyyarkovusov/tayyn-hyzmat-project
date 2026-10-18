package io.openride.driver;

import static org.junit.Assert.*;
import java.util.*;
import org.junit.Test;

public class NotificationDeliveryTest {
  private final Map<String, Long> disk = new HashMap<>();
  private final NotificationDelivery.Store store = new NotificationDelivery.Store() {
    public Map<String, Long> load() { return new HashMap<>(disk); }
    public void save(Map<String, Long> next) { disk.clear(); disk.putAll(next); }
  };
  @Test public void duplicateAcrossTransportAndProcessRestartShowsOnce() {
    assertTrue(new NotificationDelivery(store).shouldDisplay("chat:1", "chat", 60000, 1000, false));
    assertFalse(new NotificationDelivery(store).shouldDisplay("chat:1", "chat", 60000, 2000, false));
  }
  @Test public void chatVisibleIsSilentButOtherScreensNotify() {
    NotificationDelivery delivery = new NotificationDelivery(store);
    assertFalse(delivery.shouldDisplay("chat:1", "chat", 60000, 1000, true));
    assertFalse(delivery.shouldDisplay("chat:1", "chat", 60000, 2000, false));
    assertTrue(delivery.shouldDisplay("chat:2", "chat", 60000, 1000, false));
  }
  @Test public void expiredOrdersCannotDisplayAndVisibleChatDoesNotSilenceOrders() {
    NotificationDelivery delivery = new NotificationDelivery(store);
    assertFalse(delivery.shouldDisplay("order:1", "orders", 20000, 20000, false));
    assertTrue(delivery.shouldDisplay("order:2", "orders", 20000, 1000, true));
  }
  @Test public void serverExpirySubtractsSlowRequestInsteadOfExtendingOffer() {
    // Server says 20 seconds remain. A 3-second request round trip leaves
    // only 17 seconds on the device, even if the wall clocks match.
    assertEquals(117_000L,
        NotificationDelivery.expiryFromServerTime(120_000L, 100_000L, 100_000L, 3_000L));
    assertEquals(120_000L,
        NotificationDelivery.expiryFromServerTime(120_000L, 100_000L, 100_000L, -1L));
  }
  @Test public void responseArrivingAfterDeadlineCannotDisplayEvenWithSkewedClock() {
    long localExpiry = NotificationDelivery.expiryFromServerTime(
        120_000L, 100_000L, 8_000_000L, 21_000L);
    assertEquals(7_999_000L, localExpiry);
    assertFalse(new NotificationDelivery(store).shouldDisplay(
        "private:late", "orders", localExpiry, 8_000_000L, false));
  }
  @Test public void sameOrderFreshAttemptIsIndependentOfDismissedOlderAttempt() {
    NotificationDelivery delivery = new NotificationDelivery(store);
    assertTrue(delivery.shouldDisplay("order:one:a", "orders", 20000, 1000, false));
    assertFalse(new NotificationDelivery(store).shouldDisplay("order:one:a", "orders", 20000, 2000, false));
    assertTrue(new NotificationDelivery(store).shouldDisplay("order:one:b", "orders", 22000, 2000, false));
  }

  @Test public void closeBeforeDelayedVerificationSuppressesOnlyMatchingAttemptAcrossRestart() {
    new NotificationDelivery(store).dismiss(Collections.singleton("order:one:a"), 1000);
    assertFalse(new NotificationDelivery(store).shouldDisplay("order:one:a", "orders", 21000, 2000, false));
    assertTrue(new NotificationDelivery(store).shouldDisplay("order:one:b", "orders", 22000, 2000, false));
  }

}
