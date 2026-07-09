# MessagingApp

A React Native (bare) app for tracking contact expiry dates and automatically sending reminder messages — via SMS, WhatsApp, or a custom URL-scheme platform — on a schedule you define with reusable templates.

## What it does

1. Add a contact with a name, phone number, and an expiry date/time.
2. Create message templates like "7 days before expiry", "on expiry day", or "3 days after expiry", with a body that can reference `{name}`, `{phone}`, `{days}`, and `{expiry}`.
3. The app matches active templates against each contact's expiry and queues a message when a template becomes due.
4. Queued messages are sent automatically (SMS/WhatsApp) or opened for manual send via the selected platform's URL scheme.
5. On Android, reminders are backed by native exact alarms, so they can fire even if the app is closed or the device is idle — plus a boot receiver, a WorkManager safety-net sweep, and a foreground 15-minute poll as a fallback.

## Tech stack

- React Native 0.86, React 19.2
- Navigation: `@react-navigation` (native-stack + bottom-tabs)
- Local storage: `react-native-quick-sqlite`
- Secure credential storage: `react-native-keychain` (used for WhatsApp Cloud API credentials)
- Android native modules (Kotlin): `AlarmManager`, `SmsManager`, Headless JS, WorkManager, AppWidgetProvider
- Tests: Jest + `react-test-renderer`

## Project layout

```
App.tsx                 Navigation root, foreground scheduler, AppState listener
index.js                RN entry point + headless-task registration
src/screens/            UI: contacts, templates, queue, settings, platforms, WhatsApp config
src/database/           SQLite schema + CRUD (contacts, templates, platforms, settings, queue, alarms)
src/utils/              Scheduling engine, queue processor, SMS/WhatsApp dispatch, validators
android/.../messagingapp/  Native Kotlin: alarm scheduling, SMS bridge, boot recovery, home-screen widget
docs/PROJECT_REPORT.md  Full architecture write-up, known issues, and audit notes
```

## Android permissions

`INTERNET`, `SEND_SMS`, `READ_PHONE_STATE`, `SCHEDULE_EXACT_ALARM`, `RECEIVE_BOOT_COMPLETED`, `WAKE_LOCK`, `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_SHORT_SERVICE`.

## Testing

```sh
npm test
```

Runs the Jest suite (database, scheduler, queue processor, template matcher, and component render tests). All suites currently pass; see `docs/PROJECT_REPORT.md` for known application-level issues being tracked separately from test health.

## Known issues

See **Section 19 (Known Issues and Risks)** of `docs/PROJECT_REPORT.md` for the current, prioritized list — including WhatsApp auto-send payload handling, queue-claim atomicity, multipart SMS result aggregation, and timezone edge cases around alarm scheduling.

---

Bootstrapped using [`@react-native-community/cli`](https://github.com/react-native-community/cli).

# Getting Started

> **Note**: Make sure you have completed the [Set Up Your Environment](https://reactnative.dev/docs/set-up-your-environment) guide before proceeding.

## Step 1: Start Metro

First, you will need to run **Metro**, the JavaScript build tool for React Native.

To start the Metro dev server, run the following command from the root of your React Native project:

```sh
# Using npm
npm start

# OR using Yarn
yarn start
```

## Step 2: Build and run your app

With Metro running, open a new terminal window/pane from the root of your React Native project, and use one of the following commands to build and run your Android or iOS app:

### Android

```sh
# Using npm
npm run android

# OR using Yarn
yarn android
```

### iOS

For iOS, remember to install CocoaPods dependencies (this only needs to be run on first clone or after updating native deps).

The first time you create a new project, run the Ruby bundler to install CocoaPods itself:

```sh
bundle install
```

Then, and every time you update your native dependencies, run:

```sh
bundle exec pod install
```

For more information, please visit [CocoaPods Getting Started guide](https://guides.cocoapods.org/using/getting-started.html).

```sh
# Using npm
npm run ios

# OR using Yarn
yarn ios
```

If everything is set up correctly, you should see your new app running in the Android Emulator, iOS Simulator, or your connected device.

This is one way to run your app — you can also build it directly from Android Studio or Xcode.

## Step 3: Modify your app

Now that you have successfully run the app, let's make changes!

Open `App.tsx` in your text editor of choice and make some changes. When you save, your app will automatically update and reflect these changes — this is powered by [Fast Refresh](https://reactnative.dev/docs/fast-refresh).

When you want to forcefully reload, for example to reset the state of your app, you can perform a full reload:

- **Android**: Press the <kbd>R</kbd> key twice or select **"Reload"** from the **Dev Menu**, accessed via <kbd>Ctrl</kbd> + <kbd>M</kbd> (Windows/Linux) or <kbd>Cmd ⌘</kbd> + <kbd>M</kbd> (macOS).
- **iOS**: Press <kbd>R</kbd> in iOS Simulator.

## Congratulations! :tada:

You've successfully run and modified your React Native App. :partying_face:

### Now what?

- If you want to add this new React Native code to an existing application, check out the [Integration guide](https://reactnative.dev/docs/integration-with-existing-apps).
- If you're curious to learn more about React Native, check out the [docs](https://reactnative.dev/docs/getting-started).

# Troubleshooting

If you're having issues getting the above steps to work, see the [Troubleshooting](https://reactnative.dev/docs/troubleshooting) page.

# Learn More

To learn more about React Native, take a look at the following resources:

- [React Native Website](https://reactnative.dev) - learn more about React Native.
- [Getting Started](https://reactnative.dev/docs/environment-setup) - an **overview** of React Native and how setup your environment.
- [Learn the Basics](https://reactnative.dev/docs/getting-started) - a **guided tour** of the React Native **basics**.
- [Blog](https://reactnative.dev/blog) - read the latest official React Native **Blog** posts.
- [`@facebook/react-native`](https://github.com/facebook/react-native) - the Open Source; GitHub **repository** for React Native.
