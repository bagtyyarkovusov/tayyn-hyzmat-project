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
}
