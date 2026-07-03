package com.messagingapp

import android.os.Bundle
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "MessagingApp"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)

  /**
   * react-native-screens requires that the activity does not try to restore
   * fragment state on process restart — Android's default state-restoration
   * flow instantiates ScreenStackFragment directly via reflection, which
   * throws IllegalStateException("Screen fragments should never be restored").
   *
   * This is exactly what was crashing the app: whenever Android killed the
   * process in the background (memory pressure / OS cleanup) and the user
   * reopened it, onCreate() received a non-null savedInstanceState and
   * Android tried to reconstruct the previous fragment tree — including the
   * screens stack — which is unsupported and crashed on launch.
   *
   * Passing null to super.onCreate() disables that restoration entirely,
   * so the app always does a clean cold start of the JS bundle/navigator
   * instead of trying (and failing) to resurrect fragment state.
   *
   * Reference: https://github.com/software-mansion/react-native-screens/issues/17#issuecomment-424704067
   */
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(null)
  }
}