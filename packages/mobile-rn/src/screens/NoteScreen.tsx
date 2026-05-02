// Read-only note viewer. Markdown source is the rendering for v1 —
// no TipTap, no remark/rehype pipeline. This keeps the bundle size
// small and avoids native-module complications on macOS.
//
// The body sits in a non-editable TextInput so the user can still
// select + copy text, but typing is disabled.

import React from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { type Note } from '@meo/shared';
import { MEO, FONT_SANS, FONT_SERIF, FONT_MONO } from '../lib/theme';

interface Props {
  note: Note;
  onBack: () => void;
}

export function NoteScreen({ note, onBack }: Props) {
  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Pressable onPress={onBack} style={styles.backBtn}>
          <Text style={styles.backText}>{'← Notes'}</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.title}>{note.title || 'Untitled'}</Text>
        <TextInput
          style={styles.body}
          value={note.body ?? ''}
          editable={false}
          multiline
          // selectable + scroll inside ScrollView only — no native
          // edit. v1 is read-only.
        />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: MEO.paper },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderBottomWidth: 1,
    borderBottomColor: MEO.paperEdge,
  },
  backBtn: { paddingHorizontal: 8, paddingVertical: 4 },
  backText: { color: MEO.accent, fontFamily: FONT_SANS, fontSize: 14 },
  scroll: { padding: 24 },
  title: {
    fontFamily: FONT_SERIF,
    fontSize: 24,
    fontWeight: '700',
    color: MEO.ink,
    marginBottom: 16,
  },
  body: {
    fontFamily: FONT_MONO,
    fontSize: 14,
    color: MEO.ink,
    lineHeight: 20,
    minHeight: 200,
  },
});
