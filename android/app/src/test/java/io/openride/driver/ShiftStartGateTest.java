package io.openride.driver;

import static org.junit.Assert.*;
import org.junit.Test;

public class ShiftStartGateTest {
  @Test public void idleInstanceAdoptsAStart() {
    assertTrue(ShiftStartGate.adopts(true, false, false));
  }
  @Test public void runningShiftOrMissingCredentialIsIgnored() {
    assertFalse(ShiftStartGate.adopts(true, true, false));
    assertFalse(ShiftStartGate.adopts(false, false, false));
  }
  @Test public void closingInstanceNeverAdoptsANewShift() {
    // finishShift already cleared the token, but stopSelf() has not run yet.
    assertFalse(ShiftStartGate.adopts(true, false, true));
  }
  @Test public void startWithNoServiceStartsImmediately() {
    assertEquals(ShiftStartGate.Request.START, ShiftStartGate.request(false, false, true));
  }
  @Test public void startWhileActiveShiftRunsIsRejected() {
    assertEquals(ShiftStartGate.Request.REJECT, ShiftStartGate.request(true, false, true));
  }
  @Test public void quickOfflineOnlineWaitsForTheClosingInstance() {
    assertEquals(ShiftStartGate.Request.WAIT, ShiftStartGate.request(true, true, true));
    // Once destroyed, the deferred start launches a fresh instance.
    assertEquals(ShiftStartGate.Request.START, ShiftStartGate.request(false, false, true));
  }
  @Test public void closingInstanceThatNeverFinishesFailsVisibly() {
    assertEquals(ShiftStartGate.Request.REJECT, ShiftStartGate.request(true, true, false));
  }
}
