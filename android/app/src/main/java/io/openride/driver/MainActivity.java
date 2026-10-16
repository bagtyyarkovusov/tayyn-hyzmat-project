package io.openride.driver;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(android.os.Bundle savedInstanceState) {
    registerPlugin(DriverShiftPlugin.class);
    registerPlugin(DriverNavigationPlugin.class);
    super.onCreate(savedInstanceState);
  }
}
