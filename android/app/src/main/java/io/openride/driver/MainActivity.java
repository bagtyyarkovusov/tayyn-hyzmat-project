package io.openride.driver;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(android.os.Bundle savedInstanceState) {
    registerPlugin(DriverShiftPlugin.class);
    registerPlugin(DriverNotificationsPlugin.class);
    registerPlugin(DriverNavigationPlugin.class);
    registerPlugin(DriverUiPlugin.class);
    super.onCreate(savedInstanceState);
    PushNotificationService.opened(this, getIntent());
    ((DriverUiPlugin) bridge.getPlugin("DriverUi").getInstance()).attach();
  }
  @Override protected void onNewIntent(android.content.Intent intent) {
    super.onNewIntent(intent);
    PushNotificationService.opened(this, intent);
  }
}
