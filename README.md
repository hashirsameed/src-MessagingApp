# MessagingApp

MessagingApp is a React Native reminder application for managing contacts with expiry dates and sending timely follow-up messages. It is designed for use cases such as renewals, contract deadlines, subscriptions, or any situation where a person or business needs reminders before or after an important date.

## What the app is built to do

The app lets a user:

- add contacts with a name, phone number, and expiry date/time
- create reusable reminder templates such as "7 days before expiry", "on expiry day", or "3 days after expiry"
- personalize each reminder using placeholders like {name}, {phone}, {days}, and {expiry}
- queue reminders automatically when they become due
- send those reminders through SMS, WhatsApp, or custom URL-based platforms

## Core workflow

1. A user adds a contact and sets an expiry date/time.
2. The user creates one or more reminder templates with a relative offset such as -7, 0, or +3 days.
3. The app evaluates each contact against the active templates and decides whether a reminder should be triggered.
4. When a reminder becomes due, it is inserted into a local queue.
5. The queue processor sends the message through the selected platform or opens a manual URL scheme for the user.

## What makes this app different

This project is not just a simple reminder list. It includes:

- a scheduling engine that checks upcoming expiries and matches the correct templates
- Android-native exact alarm support so reminders can fire even when the app is closed
- background processing for headless reminder delivery
- a queue system with deduplication, retry handling, and rate limiting
- support for both automatic and manual message delivery paths
- settings for default platform selection, WhatsApp configuration, and Android permission repair

## Supported delivery channels

### SMS

- Uses Android SMS APIs when permission is available
- Supports automatic sending from the queue processor
- Includes rate limiting to avoid sending too many SMS messages in a short period

### WhatsApp

- Supports manual URL-based WhatsApp sending
- Also supports configuration for WhatsApp Cloud API integration and Meta template workflows

### Custom platforms

- Users can define custom platforms using URL schemes
- The app supports placeholder-based message construction for these integrations

## Scheduling and reliability

The reminder system has multiple layers:

- a foreground scheduler that runs on startup, when the app returns to the foreground, and on a periodic interval
- Android exact alarms for time-based reminders even when the app is not actively running
- a WorkManager safety-net service for periodic re-checking on Android
- boot-time rescheduling so alarms are restored after device restarts
- a queue processor that claims pending items, dispatches them, and updates their status

This makes the app more robust than a simple local timer and helps it survive app backgrounding or device restarts.

## Data model and app state

The app stores its state locally in SQLite and keeps separate tables for:

- contacts
- reminder templates
- queued messages
- scheduled alarms
- user settings and platform configuration

This allows the app to keep track of what has already been sent, what is still pending, and what alarms have already been triggered.

## Project structure

- App.tsx — app entry point, navigation, scheduler startup, and app-state handling
- index.js — React Native registration and headless task setup
- src/screens — UI for contacts, templates, queue, settings, and platform management
- src/database — SQLite schema and database helpers
- src/utils — scheduling logic, queue processing, delivery logic, template matching, and validation
- android/app/src/main/java/com/messagingapp — Android-native reminder and delivery integration
- docs/PROJECT_REPORT.md — full architecture notes, audit findings, and known issues

## Tech stack

- React Native 0.86.0
- React 19.2.3
- Navigation with @react-navigation
- Local storage with react-native-quick-sqlite and @op-engineering/op-sqlite
- Secure credential storage with react-native-keychain
- Kotlin native modules for alarms, SMS, WorkManager, and reminder surfaces
- Jest with React Native test support

## Getting started

### Prerequisites

- Node.js 22.11 or newer
- a working React Native development environment for Android and/or iOS
- Android Studio for Android builds
- CocoaPods for iOS builds

### Install dependencies

From the project folder:

```sh
npm install
```

### Start Metro

```sh
npm start
```

### Run on Android

```sh
npm run android
```

### Run on iOS

```sh
bundle install
bundle exec pod install
npm run ios
```

## Android permissions

The app uses the following Android capabilities and permissions:

- INTERNET
- SEND_SMS
- READ_PHONE_STATE
- SCHEDULE_EXACT_ALARM
- RECEIVE_BOOT_COMPLETED
- WAKE_LOCK
- REQUEST_IGNORE_BATTERY_OPTIMIZATIONS
- FOREGROUND_SERVICE
- FOREGROUND_SERVICE_SHORT_SERVICE

## Testing

Run the test suite with:

```sh
npm test
```

## Notes and known issues

The project documentation currently notes a few important caveats:

- WhatsApp auto-send still needs further refinement for production use
- multipart SMS result handling may be inconsistent
- alarm timing around timezone and daylight-saving transitions still needs attention
- production logging should be sanitized to avoid exposing personal data

## Additional documentation

For the full architecture overview, implementation notes, and current audit status, see:

- [docs/PROJECT_REPORT.md](docs/PROJECT_REPORT.md)
