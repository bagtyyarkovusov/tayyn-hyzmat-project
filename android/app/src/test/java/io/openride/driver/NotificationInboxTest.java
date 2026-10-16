package io.openride.driver;

import static org.junit.Assert.*;

import java.util.*;
import org.junit.Test;

public class NotificationInboxTest {
  @Test
  public void replayDoesNotRingAgainAndMissingOrExpiredOrdersAreRemoved() {
    List<String> observed = new ArrayList<>();
    NotificationInbox inbox =
        new NotificationInbox(
            new NotificationInbox.Sink() {
              public void show(NotificationInbox.Event event) {
                observed.add("show:" + event.id);
              }

              public void cancel(String id) {
                observed.add("cancel:" + id);
              }
            });
    NotificationInbox.Event order =
        new NotificationInbox.Event(
            "order:1", "orders", "Новый заказ", "Откройте приложение", 20000);
    NotificationInbox.Event chat =
        new NotificationInbox.Event("chat:1", "chat", "Диспетчер", "Новое сообщение", 60000);
    inbox.reconcile(Arrays.asList(order, chat), 10000);
    inbox.reconcile(Arrays.asList(order, chat), 11000);
    assertEquals(Arrays.asList("show:order:1", "show:chat:1"), observed);
    inbox.reconcile(Collections.singletonList(chat), 12000);
    assertEquals("cancel:order:1", observed.get(2));
    inbox.reconcile(Arrays.asList(order, chat), 21000);
    assertEquals(3, observed.size());
    inbox.stop();
    assertEquals("cancel:chat:1", observed.get(3));
  }

  @Test
  public void clearingOneChannelDoesNotClearAnotherOrReplayDismissedEvents() {
    List<String> observed = new ArrayList<>();
    NotificationInbox inbox =
        new NotificationInbox(
            new NotificationInbox.Sink() {
              public void show(NotificationInbox.Event event) {
                observed.add("show:" + event.id);
              }

              public void cancel(String id) {
                observed.add("cancel:" + id);
              }
            });
    List<NotificationInbox.Event> events =
        Arrays.asList(
            new NotificationInbox.Event("order:1", "orders", "", "", 60000),
            new NotificationInbox.Event("chat:1", "chat", "", "", 60000));
    inbox.reconcile(events, 10000);
    inbox.clear("orders");
    inbox.reconcile(events, 11000);
    assertEquals(Arrays.asList("show:order:1", "show:chat:1", "cancel:order:1"), observed);
    inbox.stop();
    assertEquals("cancel:chat:1", observed.get(3));
  }
}
