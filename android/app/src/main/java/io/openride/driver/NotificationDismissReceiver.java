package io.openride.driver;

import android.content.*;
import java.util.Collections;

/** Swipe stops only this attempt. Its persisted seen entry remains intact. */
public final class NotificationDismissReceiver extends BroadcastReceiver {
  @Override public void onReceive(Context context, Intent intent) {
    String id = intent.getStringExtra("eventId");
    if (id != null) PushNotificationService.clear(context, intent.getStringExtra("channel"), Collections.singleton(id));
  }
}
