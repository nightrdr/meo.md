// Full-screen search modal on mobile. Plain substring nav over decrypted
// notes/folders/tags - same scope as the desktop ⌘K. Hybrid AI retrieval
// stays on the AI sheet (per spec §7.5).

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Modal, View, Text, TextInput, Pressable, ScrollView, KeyboardAvoidingView, Platform,
} from 'react-native';
import { MEO, FONT_SANS, FONT_SERIF, alpha } from './theme';
import { Icon } from './Icon';
import type { Note } from './shared';

interface Match {
  type: 'note' | 'folder' | 'tag';
  id: string;
  title: string;
  snippet?: string;
  folder?: string;
  count?: number;
}

interface Props {
  visible: boolean;
  notes: Note[];
  folders: { path: string; count: number }[];
  onClose: () => void;
  onSelectNote: (id: string) => void;
  onSelectFolder: (path: string) => void;
  onSelectTag: (tag: string) => void;
}

export function SearchOverlay({
  visible, notes, folders, onClose, onSelectNote, onSelectFolder, onSelectTag,
}: Props) {
  const [q, setQ] = useState('');
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    if (visible) {
      setQ('');
      // give Modal time to mount before focusing
      const t = setTimeout(() => inputRef.current?.focus(), 250);
      return () => clearTimeout(t);
    }
  }, [visible]);

  const matches = useMemo<Match[]>(() => {
    const needle = q.trim().toLowerCase();
    const out: Match[] = [];
    if (!needle) {
      for (const n of notes.slice().sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 8)) {
        out.push({ type: 'note', id: n.id, title: n.title || 'Untitled', folder: n.folder.join('/'), snippet: firstLine(n.body) });
      }
      return out;
    }
    for (const n of notes) {
      const hay = ((n.title || '') + ' ' + n.body + ' ' + n.tags.join(' ') + ' ' + n.folder.join(' ')).toLowerCase();
      const idx = hay.indexOf(needle);
      if (idx >= 0) {
        out.push({
          type: 'note', id: n.id, title: n.title || 'Untitled',
          folder: n.folder.join('/'),
          snippet: snippetAround(n.body, needle) || firstLine(n.body),
        });
      }
    }
    for (const f of folders) {
      if (f.path && f.path.toLowerCase().includes(needle)) {
        out.push({ type: 'folder', id: f.path, title: f.path, count: f.count });
      }
    }
    const tagSet = new Map<string, number>();
    for (const n of notes) for (const t of n.tags) tagSet.set(t, (tagSet.get(t) ?? 0) + 1);
    for (const [tag, count] of tagSet) {
      if (tag.toLowerCase().includes(needle)) {
        out.push({ type: 'tag', id: tag, title: '#' + tag, count });
      }
    }
    return out.slice(0, 50);
  }, [q, notes, folders]);

  return (
    <Modal visible={visible} animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1, backgroundColor: MEO.paper }}
      >
        {/* Header */}
        <View style={{
          paddingTop: 56, paddingHorizontal: 16, paddingBottom: 12,
          borderBottomWidth: 1, borderBottomColor: MEO.paperEdge,
          flexDirection: 'row', alignItems: 'center', gap: 12,
        }}>
          <View style={{
            flex: 1, height: 40, borderRadius: 10,
            backgroundColor: alpha(MEO.ink, 0.05),
            flexDirection: 'row', alignItems: 'center',
            paddingHorizontal: 12, gap: 8,
          }}>
            <Icon.Search size={15} stroke={MEO.ink3} />
            <TextInput
              ref={inputRef}
              value={q}
              onChangeText={setQ}
              placeholder="Search notes, folders, tags"
              placeholderTextColor={MEO.ink3}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              style={{ flex: 1, fontSize: 15, color: MEO.ink, fontFamily: FONT_SANS, paddingVertical: 0 }}
            />
          </View>
          <Pressable onPress={onClose}>
            <Text style={{ fontSize: 15, color: MEO.accent, fontWeight: '600', fontFamily: FONT_SANS }}>Cancel</Text>
          </Pressable>
        </View>

        <ScrollView
          contentContainerStyle={{ paddingBottom: 80 }}
          keyboardShouldPersistTaps="handled"
        >
          {matches.length === 0 && (
            <Text style={{
              fontFamily: FONT_SERIF, fontStyle: 'italic',
              color: MEO.ink3, textAlign: 'center',
              paddingTop: 48, fontSize: 15,
            }}>No matches.</Text>
          )}

          {renderSection(
            q ? 'Notes' : 'Recent',
            matches.filter(m => m.type === 'note'),
            (m) => (
              <Row
                key={m.id}
                icon="Note"
                title={m.title}
                subtitle={m.snippet}
                trailing={m.folder}
                onPress={() => { onSelectNote(m.id); onClose(); }}
              />
            ),
          )}

          {renderSection(
            'Folders',
            matches.filter(m => m.type === 'folder'),
            (m) => (
              <Row
                key={m.id}
                icon="Folder"
                title={m.title}
                trailing={`${m.count} ${m.count === 1 ? 'note' : 'notes'}`}
                onPress={() => { onSelectFolder(m.id); onClose(); }}
              />
            ),
          )}

          {renderSection(
            'Tags',
            matches.filter(m => m.type === 'tag'),
            (m) => (
              <Row
                key={m.id}
                icon="Tag"
                title={m.title}
                trailing={`${m.count} ${m.count === 1 ? 'note' : 'notes'}`}
                onPress={() => { onSelectTag(m.id.replace(/^#/, '')); onClose(); }}
              />
            ),
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function renderSection<T>(title: string, rows: T[], render: (r: T) => React.ReactNode) {
  if (rows.length === 0) return null;
  return (
    <>
      <Text style={{
        paddingHorizontal: 22, paddingTop: 14, paddingBottom: 6,
        fontSize: 11, fontWeight: '600', color: MEO.ink3,
        textTransform: 'uppercase', letterSpacing: 0.6, fontFamily: FONT_SANS,
      }}>{title}</Text>
      <View style={{
        marginHorizontal: 16, marginBottom: 4,
        backgroundColor: MEO.card, borderRadius: 14,
        borderWidth: 1, borderColor: MEO.paperEdge, overflow: 'hidden',
      }}>
        {rows.map(render)}
      </View>
    </>
  );
}

function Row({ icon, title, subtitle, trailing, onPress }: {
  icon: keyof typeof Icon; title: string; subtitle?: string; trailing?: string; onPress: () => void;
}) {
  const I = Icon[icon];
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row', alignItems: 'center', gap: 12,
        padding: 14,
        backgroundColor: pressed ? MEO.paperDeep : 'transparent',
        borderBottomWidth: 0.5, borderBottomColor: MEO.paperEdge,
      })}
    >
      <I size={15} stroke={MEO.ink3} />
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 15, fontWeight: '600', color: MEO.ink, fontFamily: FONT_SANS }} numberOfLines={1}>{title}</Text>
        {subtitle ? (
          <Text style={{ fontSize: 12, color: MEO.ink3, marginTop: 1, fontFamily: FONT_SANS }} numberOfLines={1}>{subtitle}</Text>
        ) : null}
      </View>
      {trailing ? <Text style={{ fontSize: 11, color: MEO.ink3, fontFamily: FONT_SANS }}>{trailing}</Text> : null}
    </Pressable>
  );
}

function firstLine(body: string): string {
  const ln = body.split('\n').find(l => l.trim() && !l.startsWith('#'));
  return ln?.slice(0, 140) ?? '';
}
function snippetAround(body: string, needle: string): string {
  const lower = body.toLowerCase();
  const i = lower.indexOf(needle);
  if (i < 0) return '';
  const start = Math.max(0, i - 30);
  const end = Math.min(body.length, i + needle.length + 60);
  return (start > 0 ? '…' : '') + body.slice(start, end) + (end < body.length ? '…' : '');
}
