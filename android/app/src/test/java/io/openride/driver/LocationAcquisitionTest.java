package io.openride.driver;

import static org.junit.Assert.*;
import static org.robolectric.Shadows.shadowOf;

import android.Manifest;
import android.content.Context;
import android.location.Location;
import android.location.LocationManager;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public class LocationAcquisitionTest {
  private final Context context = RuntimeEnvironment.getApplication();
  private final LocationManager manager =
      (LocationManager) context.getSystemService(Context.LOCATION_SERVICE);
  private final Handler handler = new Handler(Looper.getMainLooper());

  @Before
  public void allowLocation() {
    shadowOf(RuntimeEnvironment.getApplication())
        .grantPermissions(
            Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION);
  }

  private Location fix(String provider, long ageMs, float accuracy) {
    Location fix = new Location(provider);
    fix.setLatitude(37.96);
    fix.setLongitude(58.32);
    fix.setAccuracy(accuracy);
    fix.setTime(System.currentTimeMillis() - ageMs);
    fix.setElapsedRealtimeNanos(
        SystemClock.elapsedRealtimeNanos() - TimeUnit.MILLISECONDS.toNanos(ageMs));
    return fix;
  }

  @Test
  public void networkOnlyDeviceObtainsFreshLocation() {
    shadowOf(manager).setProviderEnabled(LocationManager.GPS_PROVIDER, false);
    shadowOf(manager).setProviderEnabled(LocationManager.NETWORK_PROVIDER, true);
    assertTrue(LocationAcquisition.enabled(manager));
    List<Location> received = new ArrayList<>();
    LocationAcquisition source = new LocationAcquisition(context, handler, null);
    source.start(received::add);
    shadowOf(manager).simulateLocation(fix(LocationManager.NETWORK_PROVIDER, 0, 30));
    shadowOf(Looper.getMainLooper()).idle();
    assertEquals(1, received.size());
    source.stop();
  }

  @Test
  public void bothHardwareProvidersContinueObtainingFreshFixesAndStopCleanly() {
    shadowOf(manager).setProviderEnabled(LocationManager.GPS_PROVIDER, true);
    shadowOf(manager).setProviderEnabled(LocationManager.NETWORK_PROVIDER, true);
    List<Location> received = new ArrayList<>();
    LocationAcquisition source = new LocationAcquisition(context, handler, null);
    source.start(received::add);
    shadowOf(manager).simulateLocation(fix(LocationManager.GPS_PROVIDER, 0, 8));
    shadowOf(Looper.getMainLooper()).idle();
    shadowOf(manager).simulateLocation(fix(LocationManager.NETWORK_PROVIDER, 0, 30));
    shadowOf(Looper.getMainLooper()).idle();
    assertEquals(2, received.size());
    source.stop();
    shadowOf(manager).simulateLocation(fix(LocationManager.GPS_PROVIDER, 0, 8));
    shadowOf(Looper.getMainLooper()).idle();
    assertEquals(2, received.size());
    assertTrue(shadowOf(manager).getLocationUpdateListeners().isEmpty());
  }

  @Test
  public void freshAccurateLastKnownResolvesWithoutWaitingButOldOrInvalidFixesDoNot() {
    // All ages below use the Android monotonic clock.
    shadowOf(Looper.getMainLooper()).idleFor(70, TimeUnit.SECONDS);
    shadowOf(manager).setProviderEnabled(LocationManager.NETWORK_PROVIDER, true);
    shadowOf(manager)
        .setLastKnownLocation(
            LocationManager.NETWORK_PROVIDER, fix(LocationManager.NETWORK_PROVIDER, 60000, 100));
    List<Location> received = new ArrayList<>();
    LocationAcquisition source = new LocationAcquisition(context, handler, null);
    source.start(received::add);
    assertEquals(1, received.size());
    source.stop();
    assertFalse(LocationAcquisition.usable(fix("gps", 60001, 10)));
    assertFalse(LocationAcquisition.usable(fix("gps", -1000, 10)));
    assertFalse(LocationAcquisition.usable(fix("gps", 0, 101)));
    Location invalid = fix("gps", 0, 5);
    invalid.setLatitude(Double.NaN);
    assertFalse(LocationAcquisition.usable(invalid));
    Location missingAccuracy = fix("gps", 0, 5);
    missingAccuracy.removeAccuracy();
    assertFalse(LocationAcquisition.usable(missingAccuracy));
    Location wallClockWrong = fix("gps", 1000, 5);
    wallClockWrong.setTime(1);
    assertTrue(LocationAcquisition.usable(wallClockWrong));
  }

  @Test
  public void fusedIsPreferredAndLateCallbacksCannotLeakAcrossRestart() {
    shadowOf(manager).setProviderEnabled(LocationManager.GPS_PROVIDER, true);
    FakeFused fused = new FakeFused();
    LocationAcquisition source = new LocationAcquisition(context, handler, fused);
    List<Location> first = new ArrayList<>();
    source.start(first::add);
    LocationAcquisition.FixCallback old = fused.callback;
    fused.callback.accept(fix("fused", 0, 8));
    assertEquals(1, first.size());
    assertTrue(shadowOf(manager).getLocationUpdateListeners().isEmpty());
    source.stop();
    assertTrue(fused.stopped);
    List<Location> next = new ArrayList<>();
    source.start(next::add);
    old.accept(fix("fused", 0, 5));
    assertEquals(0, next.size());
    fused.callback.accept(fix("fused", 0, 10));
    assertEquals(1, next.size());
    source.stop();
  }

  @Test
  public void coldStartHasFiniteWindowAndLateTimeoutCannotStopANewAttempt() {
    shadowOf(manager).setProviderEnabled(LocationManager.GPS_PROVIDER, true);
    FakeFused fused = new FakeFused();
    LocationAcquisition source = new LocationAcquisition(context, handler, fused);
    List<Location> received = new ArrayList<>();
    int[] failures = {0};
    source.once(90000, received::add, () -> failures[0]++);
    LocationAcquisition.FixCallback old = fused.callback;
    shadowOf(Looper.getMainLooper()).idleFor(89, TimeUnit.SECONDS);
    assertEquals(0, failures[0]);
    shadowOf(Looper.getMainLooper()).idleFor(1, TimeUnit.SECONDS);
    assertEquals(1, failures[0]);
    assertTrue(fused.stopped);
    source.once(90000, received::add, () -> failures[0]++);
    old.accept(fix("fused", 0, 10));
    assertEquals(0, received.size());
    fused.callback.accept(fix("fused", 0, 10));
    assertEquals(1, received.size());
    shadowOf(Looper.getMainLooper()).idleFor(91, TimeUnit.SECONDS);
    assertEquals(1, failures[0]);
    source.once(90000, received::add, () -> failures[0]++);
    source.stop();
    shadowOf(Looper.getMainLooper()).idleFor(91, TimeUnit.SECONDS);
    assertEquals(1, failures[0]);
  }

  @Test
  public void unavailableFusedFallsBackToEnabledHardwareProviders() {
    shadowOf(manager).setProviderEnabled(LocationManager.GPS_PROVIDER, true);
    shadowOf(manager).setProviderEnabled(LocationManager.NETWORK_PROVIDER, true);
    LocationAcquisition source =
        new LocationAcquisition(
            context,
            handler,
            new FakeFused() {
              @Override
              public void start(LocationAcquisition.FixCallback callback, Runnable unavailable) {
                unavailable.run();
              }
            });
    List<Location> received = new ArrayList<>();
    source.start(received::add);
    shadowOf(Looper.getMainLooper()).idle();
    shadowOf(manager).simulateLocation(fix("network", 0, 40));
    shadowOf(Looper.getMainLooper()).idle();
    assertEquals(1, received.size());
    source.stop();
  }

  @Test
  public void disabledMasterLocationIsReportedEvenWithProviderConfiguration() {
    shadowOf(manager).setProviderEnabled(LocationManager.GPS_PROVIDER, true);
    shadowOf(manager).setLocationEnabled(false);
    assertFalse(LocationAcquisition.enabled(manager));
  }

  @Test
  @Config(sdk = 26)
  public void pre28EnabledDetectionAcceptsNetworkAndRejectsPassiveOnly() {
    shadowOf(manager).setProviderEnabled(LocationManager.GPS_PROVIDER, false);
    shadowOf(manager).setProviderEnabled(LocationManager.NETWORK_PROVIDER, true);
    assertTrue(LocationAcquisition.enabled(manager));
    shadowOf(manager).setProviderEnabled(LocationManager.NETWORK_PROVIDER, false);
    shadowOf(manager).setProviderEnabled(LocationManager.PASSIVE_PROVIDER, true);
    assertFalse(LocationAcquisition.enabled(manager));
  }

  static class FakeFused implements LocationAcquisition.Fused {
    LocationAcquisition.FixCallback callback;
    boolean stopped;

    public void start(LocationAcquisition.FixCallback callback, Runnable unavailable) {
      this.callback = callback;
      stopped = false;
    }

    public void stop() {
      stopped = true;
    }
  }
}
