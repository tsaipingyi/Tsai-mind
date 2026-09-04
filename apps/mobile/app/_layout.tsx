import { useEffect } from 'react';
import { ActivityIndicator, Platform, StyleSheet, View } from 'react-native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { C } from '../src/theme';
import { Toasts } from '../src/components/ui';
import { useSession } from '../src/state/session';
import { useSettings } from '../src/state/settings';
import { queue, startSync } from '../src/sync/runtime';
import { setRouter, startPush } from '../src/push';

export default function RootLayout() {
  const checking = useSession((s) => s.checking);
  const token = useSession((s) => s.token);
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    startSync();
    void queue.load();
    void useSettings.getState().load();
    void useSession.getState().bootstrap();
  }, []);

  useEffect(() => {
    setRouter({ push: (href) => router.push(href as never) });
  }, [router]);

  // auth gate
  useEffect(() => {
    if (checking) return;
    const onLogin = segments[0] === 'login';
    if (!token && !onLogin) router.replace('/login');
    else if (token && onLogin) router.replace('/');
  }, [checking, token, segments, router]);

  // push registration after login (no-op on web / Expo Go)
  useEffect(() => {
    if (!token || Platform.OS === 'web') return;
    void startPush();
  }, [token]);

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: C.paper }}>
      <SafeAreaProvider>
        <StatusBar style="dark" />
        {checking ? (
          <View style={s.splash}>
            <ActivityIndicator color={C.ink3} />
          </View>
        ) : (
          <Stack
            screenOptions={{
              headerStyle: { backgroundColor: C.paper },
              headerTintColor: C.ink,
              headerTitleStyle: { fontWeight: '600', color: C.ink },
              headerShadowVisible: false,
              headerBackTitle: '返回',
              contentStyle: { backgroundColor: C.paper },
            }}
          >
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            <Stack.Screen name="login" options={{ headerShown: false }} />
            <Stack.Screen name="settings" options={{ title: '设置', presentation: 'modal' }} />
            <Stack.Screen name="pending" options={{ title: '待确认', presentation: 'modal' }} />
            <Stack.Screen name="project/[id]" options={{ headerShown: false }} />
            <Stack.Screen name="node/[id]" options={{ headerShown: false }} />
          </Stack>
        )}
        <Toasts />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const s = StyleSheet.create({ splash: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: C.paper } });
