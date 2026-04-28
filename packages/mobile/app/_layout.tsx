import 'react-native-get-random-values';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { MEO } from '../src/theme';

export default function Layout() {
  return (
    <SafeAreaProvider>
      <StatusBar style="auto" />
      <Stack
        screenOptions={{
          headerShown: false,                         // we draw our own headers
          contentStyle: { backgroundColor: MEO.paper },
        }}
      >
        <Stack.Screen name="index" />
        <Stack.Screen name="folders" />
        <Stack.Screen name="folder/[path]" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="note/[id]" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="settings/ai" options={{ animation: 'slide_from_bottom' }} />
      </Stack>
    </SafeAreaProvider>
  );
}
