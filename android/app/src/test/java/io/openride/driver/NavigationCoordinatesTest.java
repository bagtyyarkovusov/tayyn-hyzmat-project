package io.openride.driver;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import org.junit.Test;

public class NavigationCoordinatesTest {
  @Test public void acceptsRealCoordinatesIncludingOneZeroAxis() {
    assertTrue(NavigationCoordinates.valid(37.961, 58.321));
    assertTrue(NavigationCoordinates.valid(0.0, 58.321));
    assertTrue(NavigationCoordinates.valid(37.961, 0.0));
  }

  @Test public void rejectsMissingNonFiniteAndOutOfRangeTargets() {
    assertFalse(NavigationCoordinates.valid(null, 58.321));
    assertFalse(NavigationCoordinates.valid(37.961, null));
    assertFalse(NavigationCoordinates.valid(Double.NaN, 58.321));
    assertFalse(NavigationCoordinates.valid(37.961, Double.POSITIVE_INFINITY));
    assertFalse(NavigationCoordinates.valid(91.0, 58.321));
    assertFalse(NavigationCoordinates.valid(37.961, -181.0));
  }

  @Test public void rejectsTheUnsetZeroCoordinateSentinel() {
    assertFalse(NavigationCoordinates.valid(0.0, 0.0));
  }
}
