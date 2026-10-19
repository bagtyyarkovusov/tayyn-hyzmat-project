package io.openride.driver;

import static org.junit.Assert.*;
import org.junit.Test;

public class BackPressPolicyTest {
  @Test public void secondRootPressWithinTwoSecondsMinimizes() {
    BackPressPolicy back = new BackPressPolicy();
    assertFalse(back.root(100));
    assertTrue(back.root(2100));
    assertFalse(back.root(2200));
  }
  @Test public void navigationOverlayOrPauseResetsWindow() {
    BackPressPolicy back = new BackPressPolicy();
    assertFalse(back.root(100));
    back.reset();
    assertFalse(back.root(500));
    assertFalse(back.root(2501));
    assertTrue(back.root(2600));
  }
  @Test public void pressWhileWebAnswerIsPendingIsIgnored() {
    BackPressPolicy back = new BackPressPolicy();
    long first = back.request();
    assertNotEquals(0, first);
    assertEquals(0, back.request());
    assertTrue(back.settle(first));
    assertNotEquals(0, back.request());
  }
  @Test public void lateWebAnswerAfterTimeoutCannotActAgain() {
    BackPressPolicy back = new BackPressPolicy();
    long request = back.request();
    // The 1.5 s timeout settles the request and native applies a root press.
    assertTrue(back.settle(request));
    assertFalse(back.root(100));
    // The web answer arriving afterwards is ignored and keeps the root window.
    assertFalse(back.settle(request));
    long next = back.request();
    assertNotEquals(request, next);
    assertFalse(back.settle(request));
    assertTrue(back.settle(next));
    assertTrue(back.root(1500));
  }
  @Test public void answeredRequestIsNotSettledAgainByItsTimeout() {
    BackPressPolicy back = new BackPressPolicy();
    long request = back.request();
    assertTrue(back.settle(request));
    assertFalse(back.settle(request));
  }
  @Test public void resetDropsAPendingRequest() {
    BackPressPolicy back = new BackPressPolicy();
    long request = back.request();
    back.reset();
    assertFalse(back.settle(request));
    assertNotEquals(0, back.request());
  }
}
