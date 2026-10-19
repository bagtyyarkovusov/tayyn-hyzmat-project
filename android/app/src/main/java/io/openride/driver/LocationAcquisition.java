package io.openride.driver;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import androidx.core.content.ContextCompat;
import com.google.android.gms.common.ConnectionResult;
import com.google.android.gms.common.GoogleApiAvailability;
import com.google.android.gms.location.*;
import java.util.concurrent.TimeUnit;

/** Shared local acquisition for the visible WebView and the native shift. Never uploads. */
final class LocationAcquisition {
  static final long MAX_AGE_MS = 60000;
  // Region/shift eligibility needs a usable fix, not a country-wide approximate point.
  static final float MAX_ACCURACY_METRES = 100;

  interface FixCallback {
    void accept(Location fix);
  }

  interface Fused {
    void start(FixCallback callback, Runnable unavailable);

    void stop();
  }

  private final Context context;
  private final LocationManager manager;
  private final Handler handler;
  private final Fused fused;
  private LocationListener listener;
  private long generation;
  private Runnable timeout;

  LocationAcquisition(Context context, Handler handler) {
    this(
        context,
        handler,
        GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(context)
                == ConnectionResult.SUCCESS
            ? new PlayFused(context)
            : null);
  }

  LocationAcquisition(Context context, Handler handler, Fused fused) {
    this.context = context;
    manager = (LocationManager) context.getSystemService(Context.LOCATION_SERVICE);
    this.handler = handler;
    this.fused = fused;
  }

  static boolean enabled(LocationManager manager) {
    if (manager == null) return false;
    if (Build.VERSION.SDK_INT >= 28) return manager.isLocationEnabled();
    for (String provider : manager.getProviders(true)) {
      if (!LocationManager.PASSIVE_PROVIDER.equals(provider)) return true;
    }
    return false;
  }

  private static boolean providerEnabled(LocationManager manager, String provider) {
    try {
      return manager.isProviderEnabled(provider);
    } catch (IllegalArgumentException error) {
      return false;
    }
  }

  static long ageMs(Location fix) {
    return TimeUnit.NANOSECONDS.toMillis(
        SystemClock.elapsedRealtimeNanos() - fix.getElapsedRealtimeNanos());
  }

  static boolean usable(Location fix) {
    if (fix == null
        || !fix.hasAccuracy()
        || (Float.isNaN(fix.getAccuracy()) || Float.isInfinite(fix.getAccuracy()))
        || fix.getAccuracy() < 0
        || fix.getAccuracy() > MAX_ACCURACY_METRES
        || (Double.isNaN(fix.getLatitude()) || Double.isInfinite(fix.getLatitude()))
        || Math.abs(fix.getLatitude()) > 90
        || (Double.isNaN(fix.getLongitude()) || Double.isInfinite(fix.getLongitude()))
        || Math.abs(fix.getLongitude()) > 180) return false;
    long age = SystemClock.elapsedRealtimeNanos() - fix.getElapsedRealtimeNanos();
    return age >= 0 && age <= TimeUnit.MILLISECONDS.toNanos(MAX_AGE_MS);
  }

  void start(FixCallback callback) {
    stop();
    long request = generation;
    long[] latest = {-1L};
    FixCallback guarded =
        fix -> {
          if (request != generation || !usable(fix) || fix.getElapsedRealtimeNanos() < latest[0])
            return;
          latest[0] = fix.getElapsedRealtimeNanos();
          callback.accept(fix);
        };
    if (fused != null) {
      fused.start(
          guarded,
          () ->
              handler.post(
                  () -> {
                    if (request != generation) return;
                    fused.stop();
                    startHardware(guarded, request);
                  }));
    } else startHardware(guarded, request);
  }

  private void startHardware(FixCallback callback, long request) {
    if (manager == null || listener != null || request != generation) return;
    if (ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION)
            != PackageManager.PERMISSION_GRANTED
        && ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION)
            != PackageManager.PERMISSION_GRANTED) return;
    listener =
        new LocationListener() {
          public void onLocationChanged(Location fix) {
            callback.accept(fix);
          }

          public void onProviderEnabled(String provider) {}

          public void onProviderDisabled(String provider) {}

          public void onStatusChanged(String provider, int status, Bundle extras) {}
        };
    // Register both enabled providers before delivering a cache hit, since a
    // one-shot caller may stop us synchronously from its first callback.
    for (String provider :
        new String[] {LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER}) {
      if (providerEnabled(manager, provider)) {
        try {
          manager.requestLocationUpdates(provider, 10000, 0, listener, Looper.getMainLooper());
        } catch (SecurityException denied) {
          // Coarse-only access can still use network. Never crash on revocation.
        }
      }
    }
    Location best = null;
    for (String provider :
        new String[] {LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER}) {
      if (!providerEnabled(manager, provider)) continue;
      Location candidate;
      try {
        candidate = manager.getLastKnownLocation(provider);
      } catch (SecurityException denied) {
        continue;
      }
      if (usable(candidate)
          && (best == null || candidate.getElapsedRealtimeNanos() > best.getElapsedRealtimeNanos()))
        best = candidate;
    }
    if (best != null) callback.accept(best);
  }

  void once(long windowMs, FixCallback callback, Runnable expired) {
    boolean[] completed = {false};
    start(
        fix -> {
          completed[0] = true;
          stop();
          callback.accept(fix);
        });
    if (completed[0]) return;
    long request = generation;
    timeout =
        () -> {
          if (request == generation) {
            stop();
            expired.run();
          }
        };
    handler.postDelayed(timeout, windowMs);
  }

  void stop() {
    generation++;
    if (timeout != null) handler.removeCallbacks(timeout);
    timeout = null;
    if (fused != null) fused.stop();
    if (manager != null && listener != null) manager.removeUpdates(listener);
    listener = null;
  }

  private static final class PlayFused implements Fused {
    private final Context context;
    private final FusedLocationProviderClient client;
    private LocationCallback listener;
    private long generation;

    PlayFused(Context context) {
      this.context = context;
      client = LocationServices.getFusedLocationProviderClient(context);
    }

    public void start(FixCallback callback, Runnable unavailable) {
      if (ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION)
              != PackageManager.PERMISSION_GRANTED
          && ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION)
              != PackageManager.PERMISSION_GRANTED) {
        unavailable.run();
        return;
      }
      long request = ++generation;
      listener =
          new LocationCallback() {
            @Override
            public void onLocationResult(LocationResult result) {
              if (request != generation) return;
              for (Location fix : result.getLocations()) callback.accept(fix);
            }
          };
      client
          .requestLocationUpdates(
              new LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 10000)
                  .setMinUpdateIntervalMillis(1000)
                  .setMaxUpdateAgeMillis(MAX_AGE_MS)
                  .build(),
              listener,
              Looper.getMainLooper())
          .addOnFailureListener(
              error -> {
                if (request == generation) unavailable.run();
              });
      client
          .getLastLocation()
          .addOnSuccessListener(
              fix -> {
                if (request == generation) callback.accept(fix);
              });
    }

    public void stop() {
      generation++;
      if (listener != null) client.removeLocationUpdates(listener);
      listener = null;
    }
  }
}
