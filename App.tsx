import React, { useCallback, useEffect, useRef } from 'react';
import { Text, AppState, Platform, NativeModules } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createMaterialTopTabNavigator } from '@react-navigation/material-top-tabs';

import ContactListScreen from './src/screens/ContactListScreen';
import TemplatesScreen from './src/screens/TemplatesScreen';
import CreateTemplateScreen from './src/screens/CreateTemplateScreen';
import EditTemplateScreen from './src/screens/EditTemplateScreen';
import PlatformSelectScreen from './src/screens/PlatformSelectScreen';
import AddContactScreen from './src/screens/AddContactScreen';
import PlatformManagerScreen from './src/screens/PlatformManagerScreen';
import QueueScreen from './src/screens/QueueScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import WhatsAppConfigScreen from './src/screens/WhatsAppConfigScreen';
import BulkSmsConfigScreen from './src/screens/BulkSmsConfigScreen';
import WhatsAppTemplatesScreen from './src/screens/WhatsAppTemplatesScreen';

// ─────────────────────────────────────────────────────────────────────────
// DevTestScreen is a local-only, git-ignored dev tool (see .gitignore).
// It will NOT exist on a fresh clone / another machine / CI, so it can't
// be a static top-level import — that would break the Metro bundle for
// anyone who doesn't have the file on disk. Guard it behind __DEV__ and
// a try/catch require so its absence never breaks the build for others.
//
// FIX — __DEV__ ke sath isDevModeOn() bhi check karo. Agar sirf __DEV__
// hota to ye sirf local debug build mein hi require hota — ek test/QA
// build (jahan file bundled hai lekin __DEV__ false hai) pe Dev Mode
// Settings se toggle ON karne ke baad bhi require kabhi chalta hi nahi.
// NOTE: agar ye file genuinely test-build APK mein bundled nahi hai (git
// -ignored, sirf local machine pe hai), to isDevModeOn()=true hone se bhi
// require fail hoga (try/catch usay chup-chap null kar dega) — ye sirf
// runtime toggle ka gate hai, file ko bundle mein shamil karna alag
// deployment step hai.
// ─────────────────────────────────────────────────────────────────────────
let DevTestScreen: React.ComponentType<any> | null = null;
if (__DEV__ || isDevModeOn()) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    DevTestScreen = require('./src/screens/DevTestScreen').default;
  } catch (e) {
    console.log('[App] DevTestScreen not found locally — skipping Testing Lab tab.');
    DevTestScreen = null;
  }
}

import {
  registerBackgroundScheduler,
  runExpiryCheck,
} from './src/utils/scheduler';
import {
  runPermissionOnboardingFlow,
  scheduleAlarmsForContact,
  cancelAlarmsForContact,
} from './src/utils/alarmScheduler';
import { getActiveTemplates } from './src/database/templateDB';
import { setContactListener } from './src/utils/contactEvents';
// FIX — loadDevModeCache() ko yahan (App.tsx) se call karna hai, db.js se
// NAHI. Wajah: settingsDB.js khud getDB() ko db.js se import karta hai, aur
// devMode.js settingsDB.js ko import karta hai. Agar db.js devMode.js ko
// import kare (loadDevModeCache chalane ke liye), to cycle ban jata hai:
//   db.js -> devMode.js -> settingsDB.js -> db.js
// App.tsx is cycle se bahar hai (koi bhi in teeno ke opposite direction
// mein ise import nahi karta), isliye yahan se call karna safe hai. Ye
// sirf ek OPTIONAL warm-up hai — isDevModeOn() khud bhi lazy-load karta
// hai agar cache abhi tak load na hui ho (dekho devMode.js), to iske bina
// bhi app crash ya galat value nahi degi, sirf pehla isDevModeOn() call
// thoda extra (ek DB read) kaam karega.
//
// FIX — isDevModeOn() bhi yahan import kiya (naya function nahi banaya,
// devMode.js mein already exist karta tha). Wajah: neeche DevTestScreen
// ka gate pehle sirf raw __DEV__ (local debug build) check karta tha,
// isDevModeOn() (jo settings-toggle se test/release build mein bhi dev
// tools unlock karne ke liye specifically bana tha) kabhi check hi nahi
// hota tha — is se "Testing Lab" tab test environment mein kabhi nahi
// dikhta tha, chahe Dev Mode Settings se ON kyun na kar diya jaye.
import { loadDevModeCache, isDevModeOn } from './src/utils/devMode';

const Stack = createNativeStackNavigator();
const Tab = createMaterialTopTabNavigator();

const FOREGROUND_CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

// Background-trace notification — visible proof the engine keeps working
// once the app leaves the foreground. Native side (AlarmModule) reads
// scheduled_alarms directly, so no data needs to cross the bridge here.
const { AlarmModule } = NativeModules;

const showBackgroundTrace = () => {
  if (Platform.OS !== 'android') return;
  AlarmModule?.showBackgroundTraceNotification?.().catch(() => {});
};

const hideBackgroundTrace = () => {
  if (Platform.OS !== 'android') return;
  AlarmModule?.hideBackgroundTraceNotification?.().catch(() => {});
};

function MainTabs() {
  return (
    <Tab.Navigator
      // Real swipeable pages between all 4 tabs, sliding tab bar
      // positioned at the bottom (default is top for this navigator).
      tabBarPosition="bottom"
      screenOptions={{
        swipeEnabled: true,
        animationEnabled: true,
        tabBarShowIcon: true,
        tabBarShowLabel: true,
        tabBarPressColor: 'transparent',
        tabBarStyle: {
          backgroundColor: '#fff',
          borderTopWidth: 1,
          borderTopColor: '#F0F0F0',
          elevation: 0,
          shadowOpacity: 0,
          height: 60,
        },
        // The sliding "shade" — this bar animates continuously as you
        // swipe/drag between tabs, not just on release, so it tracks
        // your finger and lands under whichever tab you land on.
        tabBarIndicatorStyle: {
          backgroundColor: '#1A1A2E',
          height: 3,
          borderRadius: 2,
        },
        tabBarIndicatorContainerStyle: {
          // Indicator sits at the top edge of the bottom bar — reads as
          // a divider that slides, separating screen content from tabs.
          top: 0,
        },
        tabBarActiveTintColor: '#1A1A2E',
        tabBarInactiveTintColor: '#BDBDBD',
        tabBarLabelStyle: {
          fontSize: 12,
          fontWeight: '600',
          textTransform: 'none',
          marginTop: 2,
        },
        tabBarItemStyle: {
          paddingTop: 8,
        },
      }}>
      <Tab.Screen
        name="Contacts"
        component={ContactListScreen}
        options={{
          tabBarLabel: 'Contacts',
          tabBarIcon: () => <Text style={{ fontSize: 20 }}>👥</Text>,
        }}
      />

      <Tab.Screen
        name="TemplateList"
        component={TemplatesScreen}
        options={{
          tabBarLabel: 'Templates',
          tabBarIcon: () => <Text style={{ fontSize: 20 }}>📝</Text>,
        }}
      />

      <Tab.Screen
        name="Queue"
        component={QueueScreen}
        options={{
          tabBarLabel: 'Queue',
          tabBarIcon: () => <Text style={{ fontSize: 20 }}>📤</Text>,
        }}
      />

      <Tab.Screen
        name="Settings"
        component={SettingsScreen}
        options={{
          tabBarLabel: 'Settings',
          tabBarIcon: () => <Text style={{ fontSize: 20 }}>⚙️</Text>,
        }}
      />
    </Tab.Navigator>
  );
}

export default function App() {
  const appState = useRef(AppState.currentState);

  // ✅ Explicit type to avoid TypeScript error
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const triggerExpiryCheck = useCallback((source: string) => {
    console.log(`[App] runExpiryCheck triggered (${source})`);
    void runExpiryCheck().then((summary) => {
      console.log(`[App] runExpiryCheck completed (${source})`, summary);
    });
  }, []);

  const startForegroundInterval = useCallback(() => {
    if (intervalRef.current) return;

    intervalRef.current = setInterval(() => {
      console.log('[App] Periodic foreground check triggered');
      triggerExpiryCheck('foreground-interval');
    }, FOREGROUND_CHECK_INTERVAL_MS);
  }, [triggerExpiryCheck]);

  const stopForegroundInterval = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  // Signal layer — reacts to contact INSERT/UPDATE/DELETE, keeps alarms in sync.
  //
  // FIX — present-due edge case (contact added/edited with an expiry that's
  // already "now", e.g. added at 7:38 PM with expiry also 7:38 PM).
  // Masla: scheduleAlarmsForContact() -> computeAlarmTimestamp() deliberately
  //         returns null for any already-past target (alarmScheduler.js) —
  //         correct, native exact alarms must not be scheduled for the past.
  //         But scheduleAlarmsForContact() itself never calls addToQueue();
  //         only schedulerEngine.js's runExpiryCheck() does that. Before this
  //         fix, INSERT/UPDATE only called scheduleAlarmsForContact() — so a
  //         genuinely present-due template just sat unqueued until the next
  //         runExpiryCheck() run, which is either app foreground-resume or
  //         the 15-minute FOREGROUND_CHECK_INTERVAL_MS timer. Result: message
  //         looked "stuck", not actually broken — just up to 15 min late.
  // Fix:   Call triggerExpiryCheck() right after scheduling alarms for an
  //         INSERT or an UPDATE that changed the expiry, so anything due
  //         "right now" gets queued (and processQueue()'d) immediately
  //         instead of waiting for the next cycle. Reusing the existing
  //         triggerExpiryCheck() (which itself reuses runExpiryCheck()) —
  //         no new function added.
  useEffect(() => {
    setContactListener(async (event: { type: string; contact?: any; contactId?: string; expiryChanged?: boolean }) => {
      if (Platform.OS !== 'android') return;
      const templates = getActiveTemplates();
      if (event.type === 'INSERT') {
        await scheduleAlarmsForContact(event.contact, templates);
        triggerExpiryCheck('contact-insert');
      } else if (event.type === 'UPDATE' && event.expiryChanged) {
        await cancelAlarmsForContact(event.contact.id);
        await scheduleAlarmsForContact(event.contact, templates);
        triggerExpiryCheck('contact-update');
      } else if (event.type === 'DELETE') {
        await cancelAlarmsForContact(event.contactId);
      }
    });
  }, [triggerExpiryCheck]);

  useEffect(() => {
    // FIX — dev-mode cache ko sabse pehle warm karo, kisi bhi screen ke
    // mount/render se pehle. registerBackgroundScheduler() aur
    // triggerExpiryCheck() dono internally debugTrace() jaisi hot-path
    // logging chala sakte hain jo isDevModeOn() check karti hai — is liye
    // yeh sabse upar, in dono se PEHLE call hona chahiye.
    loadDevModeCache();

    registerBackgroundScheduler();

    // Run once at startup
    triggerExpiryCheck('startup');

    // Start periodic checks while app is foregrounded
    startForegroundInterval();

    // Permission onboarding (Android only)
    if (Platform.OS === 'android') {
      runPermissionOnboardingFlow();
    }

    const subscription = AppState.addEventListener(
      'change',
      (nextState) => {
        if (
          appState.current.match(/inactive|background/) &&
          nextState === 'active'
        ) {
          console.log('[App] Returned to foreground');
          triggerExpiryCheck('foreground-resume');
          startForegroundInterval();
          hideBackgroundTrace();
        }

        if (nextState.match(/inactive|background/)) {
          console.log('[App] Moved to background');
          stopForegroundInterval();
          showBackgroundTrace();
        }

        appState.current = nextState;
      },
    );

    return () => {
      subscription.remove();
      stopForegroundInterval();
    };
  }, [startForegroundInterval, stopForegroundInterval, triggerExpiryCheck]);

  return (
    <SafeAreaProvider>
    <NavigationContainer>
      <Stack.Navigator
        screenOptions={{
          headerStyle: {
            backgroundColor: '#fff',
          },
          headerTintColor: '#1A1A2E',
          headerTitleStyle: {
            fontWeight: '700',
          },
          headerShadowVisible: false,
        }}>
        <Stack.Screen
          name="Main"
          component={MainTabs}
          options={{ headerShown: false }}
        />

        <Stack.Screen
          name="CreateTemplate"
          component={CreateTemplateScreen}
          options={{ title: 'New Template' }}
        />

        <Stack.Screen
          name="EditTemplate"
          component={EditTemplateScreen}
          options={{ title: 'Edit Template' }}
        />

        <Stack.Screen
          name="PlatformSelect"
          component={PlatformSelectScreen}
          options={{ title: 'Send Message' }}
        />

        <Stack.Screen
          name="AddContact"
          component={AddContactScreen}
          options={{ title: 'Add Contact' }}
        />

        <Stack.Screen
          name="PlatformManager"
          component={PlatformManagerScreen}
          options={{ title: 'Manage Platforms' }}
        />

        <Stack.Screen
          name="WhatsAppConfig"
          component={WhatsAppConfigScreen}
          options={{ title: 'WhatsApp API Setup' }}
        />

        <Stack.Screen
          name="BulkSmsConfig"
          component={BulkSmsConfigScreen}
          options={{ title: 'Bulk SMS API Setup' }}
        />

        <Stack.Screen
          name="WhatsAppTemplates"
          component={WhatsAppTemplatesScreen}
          options={{ title: 'Message Templates' }}
        />

        {(__DEV__ || isDevModeOn()) && DevTestScreen && (
          <Stack.Screen
            name="DevTestLab"
            component={DevTestScreen}
            options={{ title: 'Testing Lab' }}
          />
        )}
      </Stack.Navigator>
    </NavigationContainer>
    </SafeAreaProvider>
  );
}