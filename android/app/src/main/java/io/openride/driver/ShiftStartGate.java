package io.openride.driver;

/**
 * Start rules around a shift that is still shutting down. A closing service
 * instance never adopts a new shift: its posted stopSelf() would end it and its
 * closing flag would silence every report. The plugin instead waits briefly for
 * that instance to be destroyed, so the new start gets a fresh instance with
 * its own worker, acquisition and foreground notification.
 */
final class ShiftStartGate {
  enum Request { START, WAIT, REJECT }

  /** Whether onStartCommand may adopt this intent as the instance's shift. */
  static boolean adopts(boolean hasCredential, boolean activeShift, boolean closing) {
    return hasCredential && !activeShift && !closing;
  }

  /** Plugin start decision for the current service state. */
  static Request request(boolean running, boolean closing, boolean canWait) {
    if (!running) return Request.START;
    return closing && canWait ? Request.WAIT : Request.REJECT;
  }
}
