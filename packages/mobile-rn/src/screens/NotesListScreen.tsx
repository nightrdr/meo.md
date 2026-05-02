// Read-only list of decrypted notes. Tap a row to push a NoteScreen.
//
// Write-side (create / edit / delete) is deliberately deferred - see
// the README's "Phase 2" section. The shared API has upsertNote /
// deleteNote available when we're ready.

import React from 'react';
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { type Note } from '@meo/shared';
import { type Session } from '../lib/session';
import { MEO, FONT_SANS, FONT_SERIF } from '../lib/theme';

interface Props {
  session: Session;
  onOpenNote: (note: Note) => void;
  onOpenSettings: () => void;
}

export function NotesListScreen({ session, onOpenNote, onOpenSettings }: Props) {
  // updated_at is an ISO/HLC string in @meo/shared - string compare
  // sorts correctly (ISO 8601 is lexicographically ordered).
  const notes = Array.from(session.notes.values()).sort((a, b) =>
    (b.updated_at ?? '').localeCompare(a.updated_at ?? ''),
  );

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.brand}>Meo</Text>
        <Pressable onPress={onOpenSettings} style={styles.settingsBtn}>
          <Text style={styles.settingsText}>Settings</Text>
        </Pressable>
      </View>
      {notes.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>No notes yet</Text>
          <Text style={styles.emptySub}>
            Create some on desktop - the RN shell is read-only in v1.
          </Text>
        </View>
      ) : (
        <FlatList
          data={notes}
          keyExtractor={(n) => n.id}
          renderItem={({ item }) => (
            <Pressable
              style={styles.row}
              onPress={() => onOpenNote(item)}
            >
              <Text style={styles.rowTitle} numberOfLines={1}>
                {item.title || 'Untitled'}
              </Text>
              <Text style={styles.rowPreview} numberOfLines={2}>
                {(item.body ?? '').slice(0, 200)}
              </Text>
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: MEO.paper },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: MEO.paperEdge,
  },
  brand: {
    fontFamily: FONT_SERIF,
    fontSize: 22,
    fontWeight: '700',
    color: MEO.ink,
  },
  settingsBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
  },
  settingsText: {
    color: MEO.accent,
    fontFamily: FONT_SANS,
    fontSize: 13,
    fontWeight: '600',
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  emptyTitle: {
    fontFamily: FONT_SERIF,
    fontSize: 18,
    color: MEO.ink2,
    marginBottom: 6,
  },
  emptySub: {
    fontFamily: FONT_SANS,
    fontSize: 13,
    color: MEO.ink3,
    textAlign: 'center',
  },
  row: {
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: MEO.paperEdge,
  },
  rowTitle: {
    fontFamily: FONT_SERIF,
    fontSize: 16,
    fontWeight: '600',
    color: MEO.ink,
    marginBottom: 4,
  },
  rowPreview: {
    fontFamily: FONT_SANS,
    fontSize: 13,
    color: MEO.ink3,
    lineHeight: 18,
  },
});
