package io.openride.driver;

import android.os.*;
import android.widget.Toast;
import androidx.activity.OnBackPressedCallback;
import androidx.core.graphics.Insets;
import androidx.core.view.*;
import com.getcapacitor.*;
import com.getcapacitor.annotation.CapacitorPlugin;

/** One activity-owned Back dispatch and a replayable system-bar inset bridge. */
@CapacitorPlugin(name = "DriverUi")
public final class DriverUiPlugin extends Plugin {
  private final Handler main = new Handler(Looper.getMainLooper());
  private final BackPressPolicy back = new BackPressPolicy();
  private boolean ready;
  private JSObject insets = new JSObject().put("top", 0).put("right", 0).put("bottom", 0).put("left", 0);

  void attach() {
    MainActivity activity = (MainActivity) getActivity();
    WindowCompat.setDecorFitsSystemWindows(activity.getWindow(), false);
    activity.getWindow().setStatusBarColor(android.graphics.Color.TRANSPARENT);
    // API 22 cannot draw dark status icons, API 25 cannot draw dark nav icons.
    activity.getWindow().setNavigationBarColor(Build.VERSION.SDK_INT >= 26 ? android.graphics.Color.TRANSPARENT : 0xff202020);
    if (Build.VERSION.SDK_INT < 23) activity.getWindow().setStatusBarColor(0xff202020);
    boolean dark = (activity.getResources().getConfiguration().uiMode
        & android.content.res.Configuration.UI_MODE_NIGHT_MASK) == android.content.res.Configuration.UI_MODE_NIGHT_YES;
    WindowInsetsControllerCompat appearance = WindowCompat.getInsetsController(activity.getWindow(), activity.getWindow().getDecorView());
    appearance.setAppearanceLightStatusBars(!dark);
    appearance.setAppearanceLightNavigationBars(!dark);
    appearance.show(WindowInsetsCompat.Type.systemBars());
    ViewCompat.setOnApplyWindowInsetsListener(activity.getWindow().getDecorView(), (view, value) -> {
      Insets bars = value.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
      // WebView CSS pixels follow density at the fixed initial viewport scale.
      float density = activity.getResources().getDisplayMetrics().density;
      insets = new JSObject().put("top", bars.top / density).put("right", bars.right / density)
          .put("bottom", bars.bottom / density).put("left", bars.left / density);
      notifyListeners("insets", insets);
      return value; // The web shell owns safe padding; do not pad native content too.
    });
    activity.getOnBackPressedDispatcher().addCallback(activity, new OnBackPressedCallback(true) {
      @Override public void handleOnBackPressed() {
        WindowInsetsCompat current = ViewCompat.getRootWindowInsets(activity.getWindow().getDecorView());
        if (current != null && current.isVisible(WindowInsetsCompat.Type.ime())) {
          WindowCompat.getInsetsController(activity.getWindow(), activity.getWindow().getDecorView()).hide(WindowInsetsCompat.Type.ime());
          back.reset(); return;
        }
        if (!ready) { root(); return; }
        final long request = back.request();
        if (request == 0) return; // The web shell is still answering the last press.
        notifyListeners("back", new JSObject().put("requestId", request));
        // An unanswered press counts as a root press. Its late answer is ignored.
        main.postDelayed(() -> { if (back.settle(request)) root(); }, 1500);
      }
    });
    ViewCompat.requestApplyInsets(activity.getWindow().getDecorView());
  }
  private void root() {
    if (back.root(SystemClock.elapsedRealtime())) getActivity().moveTaskToBack(true);
    else Toast.makeText(getContext(), "Нажмите ещё раз, чтобы свернуть", Toast.LENGTH_SHORT).show();
  }
  @PluginMethod public void ready(PluginCall call) {
    getActivity().runOnUiThread(() -> { ready = true; call.resolve(insets); });
  }
  @PluginMethod public void respondBack(PluginCall call) {
    getActivity().runOnUiThread(() -> {
      Long request = call.getLong("requestId");
      if (request != null && back.settle(request)) {
        if ("root".equals(call.getString("result"))) root(); else back.reset();
      }
      call.resolve();
    });
  }
  @PluginMethod public void resetBack(PluginCall call) {
    getActivity().runOnUiThread(() -> { back.reset(); call.resolve(); });
  }
  @PluginMethod public void theme(PluginCall call) {
    getActivity().runOnUiThread(() -> {
      boolean dark = call.getBoolean("dark", false);
      WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(getActivity().getWindow(), getActivity().getWindow().getDecorView());
      controller.setAppearanceLightStatusBars(!dark);
      controller.setAppearanceLightNavigationBars(!dark);
      controller.show(WindowInsetsCompat.Type.systemBars());
      call.resolve();
    });
  }
  @PluginMethod public void detach(PluginCall call) { ready = false; back.reset(); call.resolve(); }
  @Override protected void handleOnPause() { back.reset(); }
  @Override protected void handleOnDestroy() { ready = false; back.reset(); main.removeCallbacksAndMessages(null); super.handleOnDestroy(); }
}
