package io.openride.driver;

import static org.junit.Assert.*;
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
    assertTrue(first.fixAccepted());
    // The early report ran but the request failed; the 10 s cadence takes over.
    assertFalse(first.fixAccepted());
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
