package io.openride.driver;

/** A root-only double press. Handled navigation, overlays and pause reset it. */
public final class BackPressPolicy {
  private long first = -1;
  public boolean root(long now) {
    if (first >= 0 && now >= first && now - first <= 2000) { reset(); return true; }
    first = now;
    return false;
  }
  public void reset() { first = -1; }
}
