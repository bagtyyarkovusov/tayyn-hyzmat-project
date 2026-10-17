package io.openride.driver;

/** Validation shared by every native external-map handoff. */
final class NavigationCoordinates {
  private NavigationCoordinates() {}

  static boolean valid(Double lat, Double lng) {
    return lat != null && lng != null && Double.isFinite(lat) && Double.isFinite(lng)
        && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
        // Match the map marker policy: this pair represents an unset target.
        && !(lat == 0.0 && lng == 0.0);
  }
}
