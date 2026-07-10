import React, { useCallback, useEffect, useRef } from 'react';
import { Text, AppState, Platform, NativeModules } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';

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
import WhatsAppTemplatesScreen from './src/screens/WhatsAppTemplatesScreen';

import {
  registerBackgroundScheduler,
  runExpiryCheck,
} from './src/utils/scheduler';
import { runPermissionOnboardingFlow } from './src/utils/alarmScheduler';

const Stack = createNativeStackNavigator();
const Tab = createBottomTabNavigator();

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
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: '#fff',
          borderTopColor: '#F0F0F0',
          height: 60,
          paddingBottom: 8,
        },
        tabBarActiveTintColor: '#1A1A2E',
        tabBarInactiveTintColor: '#BDBDBD',
        tabBarLabelStyle: {
          fontSize: 12,
          fontWeight: '600',
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

  useEffect(() => {
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
          name="WhatsAppTemplates"
          component={WhatsAppTemplatesScreen}
          options={{ title: 'Message Templates' }}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
