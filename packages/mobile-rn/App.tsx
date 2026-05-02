// Root navigator - tiny state machine, no react-navigation in v1.
//
// We have at most 4 screens (auth → list ↔ note, list ↔ settings),
// so a useState discriminated union keeps the dependency tree small
// and is trivial to port to react-navigation later.

import 'react-native-get-random-values';
import React, { useState } from 'react';
import { StatusBar, StyleSheet, useColorScheme, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { type Note } from '@meo/shared';
import { AuthScreen } from './src/screens/AuthScreen';
import { NotesListScreen } from './src/screens/NotesListScreen';
import { NoteScreen } from './src/screens/NoteScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { setSession, type Session } from './src/lib/session';

type Route =
  | { kind: 'auth' }
  | { kind: 'list' }
  | { kind: 'note'; note: Note }
  | { kind: 'settings' };

function App() {
  const isDarkMode = useColorScheme() === 'dark';
  const [session, setLocalSession] = useState<Session | null>(null);
  const [route, setRoute] = useState<Route>({ kind: 'auth' });

  return (
    <SafeAreaProvider>
      <StatusBar barStyle={isDarkMode ? 'light-content' : 'dark-content'} />
      <View style={styles.container}>
        {!session && (
          <AuthScreen
            onAuthenticated={(s) => {
              setLocalSession(s);
              setRoute({ kind: 'list' });
            }}
          />
        )}
        {session && route.kind === 'list' && (
          <NotesListScreen
            session={session}
            onOpenNote={(note) => setRoute({ kind: 'note', note })}
            onOpenSettings={() => setRoute({ kind: 'settings' })}
          />
        )}
        {session && route.kind === 'note' && (
          <NoteScreen
            note={route.note}
            onBack={() => setRoute({ kind: 'list' })}
          />
        )}
        {session && route.kind === 'settings' && (
          <SettingsScreen
            session={session}
            onBack={() => setRoute({ kind: 'list' })}
            onSignOut={() => {
              setSession(null);
              setLocalSession(null);
              setRoute({ kind: 'auth' });
            }}
          />
        )}
      </View>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
});

export default App;
