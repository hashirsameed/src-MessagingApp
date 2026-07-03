# MessagingApp Complete Project Report

Last reviewed: 2026-07-02

## 1. Project Ka Purpose

MessagingApp ek React Native bare app hai jo contacts, expiry dates, reusable message templates, delivery platforms, automatic reminders, queue processing, SMS sending, aur WhatsApp Cloud API integration handle karti hai.

Core idea:

1. User contact add karta hai with expiry date/time.
2. User templates banata hai, e.g. "7 days before expiry", "0 days on expiry", "-3 days after expiry".
3. App matching templates ko contact expiry ke against schedule karti hai.
4. Reminder due hone par message queue mein add hota hai.
5. Queue processor message ko selected/default platform se send/open karta hai.
6. Android par native exact alarms aur native SMS bridge use hota hai.

## 2. Technology Stack

- React Native 0.86.0
- React 19.2.3
- Navigation:
  - `@react-navigation/native`
  - `@react-navigation/native-stack`
  - `@react-navigation/bottom-tabs`
- Local database:
  - `react-native-quick-sqlite`
  - `@op-engineering/op-sqlite` also installed
- Secure credential storage:
  - `react-native-keychain`
- Android native modules:
  - Kotlin
  - `AlarmManager`
  - `SmsManager`
  - Headless JS
- Tests:
  - Jest configured, but currently failing because preset `@react-native/jest-preset` is missing.

## 3. Folder Structure

Important files:

- `App.tsx`
  - Navigation root
  - foreground scheduler startup
  - app state listener
  - permission onboarding for Android alarms/battery

- `index.js`
  - React Native app registration
  - Headless JS task registration:
    - `AlarmFiredTask`
    - `RescheduleAlarmsTask`

- `src/screens`
  - UI screens for contacts, templates, queue, settings, platforms, WhatsApp config/templates.

- `src/database`
  - SQLite table creation and CRUD wrappers.

- `src/utils`
  - scheduler logic
  - alarm scheduling bridge wrappers
  - queue processing
  - SMS/WhatsApp dispatch logic
  - validators
  - date formatting
  - Meta template APIs

- `android/app/src/main/java/com/messagingapp`
  - Native Kotlin modules for SMS and alarms.

## 4. App Navigation Wiring

Navigation starts in `App.tsx`.

### Main Stack

`NavigationContainer` contains a native stack:

- `Main`
  - bottom tabs
- `CreateTemplate`
- `EditTemplate`
- `PlatformSelect`
- `AddContact`
- `PlatformManager`
- `WhatsAppConfig`
- `WhatsAppTemplates`

### Bottom Tabs

`MainTabs()` creates four tabs:

- `Contacts`
  - component: `ContactListScreen`
- `TemplateList`
  - component: `TemplateListScreen`
- `Queue`
  - component: `QueueScreen`
- `Settings`
  - component: `SettingsScreen`

### Startup Behavior

When `App()` mounts:

1. `registerBackgroundScheduler()` is called.
2. `triggerExpiryCheck('startup')` runs `runExpiryCheck()`.
3. Foreground interval starts every 15 minutes.
4. Android permission onboarding runs:
   - exact alarm permission
   - battery optimization exemption
5. AppState listener is registered:
   - when app returns active: run expiry check and start interval
   - when app goes background/inactive: stop interval

## 5. SQLite Database Layer

Database opens in `src/database/db.js`:

```js
open({ name: 'MessagingApp.db' })
```

Tables are created on first access.

### `templates`

Columns:

- `id TEXT PRIMARY KEY`
- `title TEXT NOT NULL`
- `body TEXT NOT NULL`
- `created_at TEXT DEFAULT datetime('now')`
- `days_before INTEGER NOT NULL DEFAULT 1`
- `is_active INTEGER NOT NULL DEFAULT 1`
- `send_time TEXT`

Meaning:

- `days_before > 0`: send before expiry
- `days_before = 0`: send on expiry day
- `days_before < 0`: send after expiry
- `send_time`: optional 24-hour `HH:mm`; if null, contact expiry time is used.

### `contacts`

Columns:

- `id TEXT PRIMARY KEY`
- `name TEXT NOT NULL`
- `phone_number TEXT NOT NULL`
- `expiry_date TEXT NOT NULL`
- `expiry_datetime TEXT`

`expiry_date` is legacy. Current logic uses `expiry_datetime` as UTC ISO text, e.g. `2026-12-31T09:00:00Z`.

### `platforms`

Columns:

- `id TEXT PRIMARY KEY`
- `name TEXT NOT NULL`
- `icon TEXT NOT NULL`
- `url_scheme TEXT NOT NULL`

Used for user-defined or seeded delivery platforms.

### `settings`

Columns:

- `key TEXT PRIMARY KEY`
- `value TEXT`

Current keys:

- `default_platform`
- `sms_per_hour_limit`

### `message_queue`

Columns:

- `id TEXT PRIMARY KEY`
- `contact_id TEXT NOT NULL`
- `template_id TEXT NOT NULL`
- `platform_id TEXT NOT NULL`
- `status TEXT NOT NULL DEFAULT 'PENDING'`
- `error_reason TEXT`
- `attempt_count INTEGER NOT NULL DEFAULT 0`
- `created_at TEXT DEFAULT datetime('now')`
- `sent_at TEXT`

Statuses:

- `PENDING`
- `PROCESSING`
- `SENT`
- `FAILED`

### `scheduled_alarms`

Columns:

- `id TEXT PRIMARY KEY`
- `contact_id TEXT NOT NULL`
- `template_id TEXT NOT NULL`
- `request_code INTEGER NOT NULL`
- `trigger_at TEXT NOT NULL`
- `status TEXT NOT NULL DEFAULT 'scheduled'`
- `created_at TEXT DEFAULT datetime('now')`
- `updated_at TEXT DEFAULT datetime('now')`
- unique pair: `contact_id`, `template_id`

Statuses:

- `scheduled`
- `fired`
- `cancelled`

This table is the app-side audit/source-of-truth for native alarms.

## 6. Contact Flow

### Contact List

File: `src/screens/ContactListScreen.js`

On focus:

1. `getAllContacts()` reads contacts from SQLite.
2. Contacts are rendered with:
   - name
   - phone number
   - formatted expiry datetime
   - expiry status badge

Expiry badge logic:

- `< 0`: expired
- `0`: expires today
- `1-3`: urgent
- `> 3`: normal

### Add Contact

File: `src/screens/AddContactScreen.js`

User enters:

- full name
- Pakistan phone number
- expiry date `YYYY-MM-DD`
- expiry time in 12-hour format
- AM/PM

Validation:

- `validateName`
- `validatePhoneNumber`
- `validateDate`
- `validateTime`

Save pipeline:

1. Convert 12-hour time to 24-hour via `parse12HourTimeTo24Hour`.
2. Build local date/time:
   - `${expiryDate}T${normalizedTime}:00`
3. Convert to UTC ISO:
   - `toISOString().replace(/\.\d{3}Z$/, 'Z')`
4. Insert contact with `insertContact`.
5. On Android:
   - get active templates
   - call `scheduleAlarmsForContact(newContact, activeTemplates)`
6. Navigate back after success.

### Delete Contact

Before deleting contact:

1. Android cancels native alarms via `cancelAlarmsForContact(id)`.
2. Scheduled alarm rows are marked `cancelled`.
3. Contact row is deleted.

## 7. Template Flow

### Template List

File: `src/screens/TemplateListScreen.js`

On focus:

1. `getAllTemplates()` loads templates.
2. Each template displays:
   - title
   - send time
   - days before/after expiry
   - body preview
   - active toggle

### Create Template

File: `src/screens/CreateTemplateScreen.js`

User enters:

- title
- days before expiry
- optional send time
- active toggle
- message body

Supported body variables:

- `{name}`
- `{days}`
- `{expiry}`
- `{phone}`

Save pipeline:

1. Validate title/body/time.
2. Convert optional send time to 24-hour `HH:mm`.
3. Insert template with `insertTemplate`.
4. If Android and active:
   - get all contacts
   - call `rescheduleAlarmsForTemplate(newTemplate, allContacts)`
5. Navigate back.

### Edit Template

File: `src/screens/EditTemplateScreen.js`

Pipeline:

1. Existing `send_time` is split to 12-hour UI state.
2. User edits template fields.
3. Save updates DB via `updateTemplate`.
4. Android reschedules alarms for the template:
   - cancels old alarms for that template
   - if active, schedules new ones for all contacts

### Toggle Template Active

When switched off:

1. Template `is_active` becomes `0`.
2. Existing alarms for that template are cancelled.

When switched on:

1. Template `is_active` becomes `1`.
2. Alarms are scheduled again for all current contacts.

## 8. Message Matching Logic

File: `src/utils/templateMatcher.js`

### `getDaysUntilExpiry(expiryDatetime)`

Computes calendar-day difference in UTC:

1. Current date is converted to UTC midnight.
2. Expiry date is converted to UTC midnight.
3. Difference is divided by one day.

### `findMatchingTemplates(templates, daysLeft)`

Returns all active templates where:

```js
t.is_active === 1 && t.days_before === daysLeft
```

### `personalizeMessage(body, contact, daysLeft)`

Replaces:

- `{name}` with contact name
- `{phone}` with contact phone
- `{days}` with days left
- `{expiry}` with contact expiry datetime

## 9. Scheduler Pipeline

There are two scheduling layers.

### Layer A: Foreground/Fallback Scheduler

Files:

- `App.tsx`
- `src/utils/scheduler.js`
- `src/utils/schedulerEngine.js`

Triggers:

- app startup
- app returns to foreground
- every 15 minutes while foregrounded
- manual "Run Check Now" in Settings
- dev "Check Expiring" button on Contacts screen

Pipeline:

1. `runExpiryCheck()` sets a broad date window:
   - 20 years in the past
   - 2 years in the future
2. `getExpiringContacts(start, end)` loads contacts.
3. `getActiveTemplates()` loads templates.
4. Default platform is read:
   - `getDefaultPlatform() || 'sms'`
5. For each contact:
   - compute `daysLeft`
   - find templates matching `days_before`
   - if template has `send_time`, also require `isTemplateAlarmDue(contact, template)`
6. For each matched template:
   - call `addToQueue(contact.id, template.id, defaultPlatform)`
7. If anything was queued:
   - call `processQueue()`

### Layer B: Android Native Exact Alarm Scheduler

Files:

- `src/utils/alarmScheduler.js`
- `android/app/src/main/java/com/messagingapp/AlarmModule.kt`
- `android/app/src/main/java/com/messagingapp/AlarmReceiver.kt`
- `android/app/src/main/java/com/messagingapp/AlarmTaskService.kt`
- `src/utils/alarmHeadlessTask.js`

Purpose:

Exact reminders can fire even if app is killed or device is idle.

Pipeline:

1. JS computes target timestamp using contact expiry and template settings.
2. JS computes a deterministic request code from `contactId:templateId`.
3. JS calls native `AlarmModule.scheduleExactAlarm`.
4. Native Kotlin calls:
   - `AlarmManager.setExactAndAllowWhileIdle`
5. JS stores/updates row in `scheduled_alarms`.
6. When alarm fires:
   - Android `AlarmReceiver` receives broadcast.
   - It starts `AlarmTaskService`.
   - It acquires Headless JS wake lock.
7. `AlarmTaskService` starts `AlarmFiredTask`.
8. JS headless task:
   - validates scheduled alarm row
   - validates template still exists and active
   - validates contact still exists
   - checks trigger drift
   - queues message with default platform
   - marks alarm fired if queued or deduped
   - calls `processQueue()`

## 10. Alarm Time Calculation

File: `src/utils/alarmScheduler.js`

### `computeTargetAlarmTimestamp(contact, template)`

Steps:

1. Parse `contact.expiry_datetime`.
2. Parse `template.days_before`.
3. If `template.send_time` is missing:
   - target = expiry time minus days offset.
4. If `template.send_time` exists:
   - copy expiry date
   - subtract days offset
   - set target clock time to `send_time`

### `computeAlarmTimestamp(contact, template)`

If target timestamp is already in the past:

- returns `Date.now() + 10000`

This means overdue reminders fire almost immediately instead of being silently dropped.

## 11. Boot/Reboot Recovery

Android clears `AlarmManager` alarms after reboot.

Files:

- `BootReceiver.kt`
- `AlarmTaskService.kt`
- `alarmHeadlessTask.js`
- `alarmScheduler.js`

Pipeline:

1. Android sends `BOOT_COMPLETED`.
2. `BootReceiver` starts `AlarmTaskService` with action `RESCHEDULE_ALL_ALARMS`.
3. `AlarmTaskService` starts Headless JS task `RescheduleAlarmsTask`.
4. `RescheduleAlarmsTask` calls `rearmAllScheduledAlarmsAfterBoot()`.
5. App reads all `scheduled_alarms` rows with status `scheduled`.
6. Future alarms are scheduled again in native `AlarmManager`.
7. Past/invalid alarms are marked cancelled.

## 12. Queue Pipeline

File: `src/utils/queueProcessor.js`

### Queue Creation

Messages enter the queue from:

- foreground scheduler
- alarm fired headless task
- manual checks

`addToQueueDetailed` prevents obvious duplicates:

- if same contact/template is `PENDING` or `PROCESSING`, skip as `ALREADY_PENDING`
- if same contact/template was `SENT` in last 30 days, skip as `ALREADY_SENT_RECENTLY`

### Queue Processing

`processQueue(onProgress)` pipeline:

1. `claimPendingQueue()` marks pending rows as `PROCESSING`.
2. Load:
   - all contacts
   - all templates
   - all custom platforms
3. Build lookup maps.
4. Android asks SMS permission if platform can need SMS.
5. Check WhatsApp credential state.
6. Read SMS per-hour limit.
7. Count SMS sent in last 60 minutes.
8. For each claimed item:
   - enforce SMS rate limit
   - validate contact/template/platform exist
   - validate required phone/email
   - personalize message
   - dispatch by platform
   - mark sent/opened/failed
   - wait before next send

### Rate Limiting

Setting:

- `sms_per_hour_limit`
- default: `300`

If SMS limit is reached:

- item is reverted to `PENDING`
- it is not failed
- next scheduler run can retry later

### Status Updates

- `markAsSent(id)`
  - status = `SENT`
  - `sent_at = datetime('now')`

- `markAsFailed(id, reason)`
  - status = `FAILED`
  - set `error_reason`
  - increment `attempt_count`

- `revertToPending(id)`
  - status = `PENDING`

## 13. Delivery Channels

### SMS

Files:

- JS: `src/utils/queueProcessor.js`
- Native: `SmsModule.kt`

Android automatic SMS pipeline:

1. JS checks `SEND_SMS` permission.
2. JS calls `SmsModule.sendSms(phone, message)`.
3. Native Kotlin uses `SmsManager`.
4. Native registers a one-shot broadcast receiver for send result.
5. Native resolves JS promise:
   - `SENT`
   - `FAILED_GENERIC_FAILURE`
   - `FAILED_NO_SERVICE`
   - `FAILED_RADIO_OFF`
   - `FAILED_NULL_PDU`
   - `FAILED_UNKNOWN_CODE_x`
6. JS marks queue row sent or failed.

iOS or fallback:

- uses `Linking.openURL("sms:...")`
- user likely completes send manually.

### WhatsApp

There are two WhatsApp paths.

Manual URL scheme path:

- `PlatformSelectScreen`
- opens `whatsapp://send?phone={phone}&text={message}`

Automatic Meta API path:

- `queueProcessor.js`
- `whatsappService.js`
- uses stored Meta credentials from Keychain
- POSTs to Graph API

Credentials stored:

- service: `whatsapp_meta_credentials`
- username marker: `whatsapp_creds`
- password payload:
  - access token
  - phone number ID
  - business account ID

### Email/Gmail/Custom Platforms

Queue path supports URL scheme placeholders:

- `{phone}`
- `{email}`
- `{subject}`
- `{message}`

Manual `PlatformSelectScreen` currently replaces only:

- `{phone}`
- `{message}`

## 14. Platform Management

File: `src/screens/PlatformManagerScreen.js`

User can:

- view custom platforms
- add a platform
- choose icon
- enter URL scheme
- delete platform

Seed behavior:

- `seedDefaultPlatforms()` inserts Email and Gmail if missing.

Important note:

- default seeded email/gmail URL schemes currently use `{phone}` in `platformDB.js`, not `{email}`.

## 15. Settings Flow

File: `src/screens/SettingsScreen.js`

Features:

- choose default sending platform
- configure WhatsApp API
- set SMS per-hour limit
- dev-only manual scheduler run

Default platform behavior:

- if no default platform is set, scheduler falls back to `sms`.

WhatsApp config state:

- `hasWhatsAppCredentials()` checks access token and phone number ID.

## 16. WhatsApp Template Management

Files:

- `WhatsAppTemplatesScreen.js`
- `metaTemplateService.js`
- `metaTemplatePayload.js`
- `metaTemplateValidator.js`

Purpose:

- fetch Meta WhatsApp templates
- create Meta message templates
- validate variable structure and sample values

Meta API version:

- `v25.0`

Fetch pipeline:

1. read credentials
2. require business account ID
3. GET `/{businessAccountId}/message_templates?limit=100`
4. classify error:
   - no credentials
   - missing WABA ID
   - auth failed
   - rate limited
   - Meta server error
   - invalid response

Create pipeline:

1. validate inputs
2. build payload components:
   - HEADER
   - BODY
   - FOOTER
3. POST to `/{businessAccountId}/message_templates`

Variable rules:

- variables use Meta syntax `{{1}}`, `{{2}}`
- variables must be sequential
- text cannot start/end with variable
- no back-to-back variables
- sample values required for variables

## 17. Android Native Wiring

### Manifest

File: `android/app/src/main/AndroidManifest.xml`

Permissions:

- `INTERNET`
- `SEND_SMS`
- `READ_PHONE_STATE`
- `SCHEDULE_EXACT_ALARM`
- `USE_EXACT_ALARM`
- `RECEIVE_BOOT_COMPLETED`
- `WAKE_LOCK`
- `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`

Components:

- `MainActivity`
- `AlarmReceiver`
- `BootReceiver`
- `AlarmTaskService`

### MainActivity

File: `MainActivity.kt`

Important behavior:

- overrides `onCreate(savedInstanceState)`
- calls `super.onCreate(null)`

Reason:

- avoids `react-native-screens` fragment restoration crash after Android kills process.

### MainApplication

File: `MainApplication.kt`

Manually adds packages:

- `SmsPackage`
- `AlarmPackage`

This exposes JS modules:

- `NativeModules.SmsModule`
- `NativeModules.AlarmModule`

### AlarmModule

Functions exposed to JS:

- `scheduleExactAlarm(requestCode, contactId, templateId, timestamp)`
- `cancelExactAlarm(requestCode, contactId, templateId)`
- `canScheduleExactAlarms()`
- `openExactAlarmSettings()`
- `isIgnoringBatteryOptimizations()`
- `requestIgnoreBatteryOptimizations()`

### AlarmReceiver

When alarm fires:

1. receives intent extras
2. starts `AlarmTaskService`
3. acquires wake lock for Headless JS

### BootReceiver

When phone boots:

1. receives `BOOT_COMPLETED`
2. starts `AlarmTaskService`
3. action: `RESCHEDULE_ALL_ALARMS`

### AlarmTaskService

Routes native service starts to JS tasks:

- action `RESCHEDULE_ALL_ALARMS` -> `RescheduleAlarmsTask`
- normal alarm extras -> `AlarmFiredTask`

## 18. Important Functions Inventory

### Database

- `getDB`
  - opens DB and creates/migrates tables
- `insertContact`, `updateContact`, `deleteContact`, `getAllContacts`, `getContactById`
- `insertTemplate`, `updateTemplate`, `deleteTemplate`, `toggleTemplateActive`, `getActiveTemplates`
- `addToQueueDetailed`, `claimPendingQueue`, `markAsSent`, `markAsFailed`, `revertToPending`
- `upsertScheduledAlarm`, `markScheduledAlarmFired`, `markScheduledAlarmCancelled`
- `getDefaultPlatform`, `setDefaultPlatform`, `getSmsPerHourLimit`, `setSmsPerHourLimit`

### Scheduler

- `runExpiryCheck`
  - fallback/foreground scheduler
- `computeTargetAlarmTimestamp`
  - target time math
- `computeAlarmTimestamp`
  - immediate fallback for overdue alarms
- `scheduleAlarm`
  - JS to native alarm bridge
- `rescheduleAlarmsForTemplate`
  - cancel old template alarms and create new ones
- `rearmAllScheduledAlarmsAfterBoot`
  - boot recovery

### Queue

- `processQueue`
  - central delivery pipeline
- `dispatchItem`
  - chooses SMS/WhatsApp/linking
- `sendNativeSms`
  - bridge to `SmsModule`
- `sendViaLinking`
  - opens URL scheme

### WhatsApp

- `saveWhatsAppCredentials`
- `getWhatsAppCredentials`
- `hasWhatsAppCredentials`
- `sendWhatsAppMessage`
- `testWhatsAppConnection`
- `fetchMetaTemplates`
- `createMetaTemplate`
- `buildMetaTemplatePayload`

## 19. Known Issues And Risks

These are important from audit.

### Critical/High

1. WhatsApp automatic sending currently ignores personalized message.
   - `sendWhatsAppMessage(toPhone, message)` sends hardcoded `hello_world` template instead of `message`.

2. Queue claiming can duplicate sends during concurrent processing.
   - `claimPendingQueue()` marks all pending as processing and then returns all processing rows.

3. Multipart SMS can be misreported as sent.
   - same `PendingIntent` is used for every part; first result can resolve promise.

4. Alarm time math mixes UTC storage with local `setHours`.
   - reminders can shift around timezone/DST edges.

5. Reboot recovery cancels overdue scheduled alarms.
   - if device was off during trigger time, reminder can be lost.

6. Background/headless queue processing can request SMS permission.
   - permission prompts are not reliable in background.

7. Logs expose PII.
   - contact names, phone numbers, and template titles are printed.

### Medium

1. Some files show mojibake/encoding corruption in local tool output.
2. `READ_PHONE_STATE` appears unused.
3. Phone formatting is Pakistan-specific and inconsistent across manual vs queue paths.
4. Manual PlatformSelect supports fewer placeholders than queue path.
5. Email/Gmail seeded URL schemes use `{phone}` instead of `{email}`.
6. Jest config is currently broken.

## 20. Verification Result

Commands run during audit:

- `npm.cmd run lint`
  - passed with warnings
  - 40 warnings

- `.\gradlew.bat :app:compileDebugKotlin`
  - passed

- `npm.cmd test -- --runInBand`
  - failed
  - reason: `Preset @react-native/jest-preset not found`

## 21. End-To-End Flow Summary

### Automatic Reminder Flow

1. User creates active template.
2. User adds contact with expiry datetime.
3. App schedules exact Android alarm for contact/template pair.
4. Alarm row is saved in `scheduled_alarms`.
5. Alarm fires.
6. Native `AlarmReceiver` starts Headless JS.
7. `AlarmFiredTask` validates contact/template/alarm row.
8. Queue row is inserted.
9. `processQueue()` sends message.
10. Queue row becomes `SENT` or `FAILED`.
11. Alarm row becomes `fired`.

### Foreground Fallback Flow

1. App starts/returns foreground/interval/manual run.
2. `runExpiryCheck()` loads contacts and active templates.
3. It matches templates by `days_before`.
4. It checks optional `send_time`.
5. It queues matching messages.
6. It calls `processQueue()`.

### Manual Send Flow

1. User opens Contacts.
2. Taps "Send Message".
3. App finds a template matching current days-left.
4. User confirms.
5. App opens `PlatformSelect`.
6. User selects SMS/WhatsApp/custom.
7. App builds URL scheme.
8. `Linking.openURL(url)` opens target app.

### WhatsApp API Config Flow

1. User opens Settings.
2. Opens WhatsApp Configuration.
3. Enters token, phone number ID, optional WABA ID.
4. App stores credentials in Keychain.
5. Queue processor can send WhatsApp automatically if credentials exist.

## 22. Recommended Next Work

Priority order:

1. Fix WhatsApp automatic send to use real personalized content or approved Meta templates properly.
2. Make queue claiming atomic and run-scoped.
3. Fix multipart SMS delivery result aggregation.
4. Normalize timezone handling for alarms.
5. Add boot overdue recovery instead of cancelling due reminders.
6. Remove background permission prompts.
7. Sanitize production logs.
8. Fix Jest preset/dependency and add tests for:
   - date/time scheduling
   - queue duplicate prevention
   - template matching
   - phone formatting
   - WhatsApp payload behavior

