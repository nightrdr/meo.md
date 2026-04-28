// Folder detail screen on mobile. Long-press a note for context actions
// (Open, Copy title, Copy body, Delete). Dots button on the header opens
// folder-level actions (rename, delete).

import { useCallback, useState } from 'react';
import { View, Text, ScrollView, Pressable, Alert } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { router, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { getSession } from '../../src/store';
import {
  newDraft, saveNote, deleteNote, getEmptyFolders, setEmptyFolders,
} from '../../src/session';
import { MEO, FONT_SANS, FONT_SERIF } from '../../src/theme';
import { Icon } from '../../src/Icon';
import { ActionSheet, PromptSheet, type ActionItem } from '../../src/ActionSheet';
import { SearchOverlay } from '../../src/SearchOverlay';
import type { Note } from '../../src/shared';
import { buildFolderTree } from '../../src/session';

export default function FolderScreen() {
  const { path: rawPath } = useLocalSearchParams<{ path: string }>();
  const session = getSession();
  const [, force] = useState(0);
  const [actionSheet, setActionSheet] = useState<{ title?: string; items: ActionItem[] } | null>(null);
  const [prompt, setPrompt] = useState<{ title: string; initial?: string; submit: (v: string) => void } | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);

  useFocusEffect(useCallback(() => { force(x => x + 1); }, []));
  if (!session) { router.replace('/'); return null; }

  const path = decodeURIComponent(rawPath ?? '');
  const isAll = path === '_all';
  const isPinned = path === '_pinned';
  const isRecent = path === '_recent';
  const isTag = path.startsWith('_tag/');
  const tag = isTag ? path.slice('_tag/'.length) : null;
  const isReal = !isAll && !isPinned && !isRecent && !isTag;

  const all = Array.from(session.notes.values());
  const filtered = isAll ? all
    : isPinned ? all.filter(n => (n as any).pinned)
    : isRecent ? all.slice().sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 25)
    : isTag ? all.filter(n => n.tags.includes(tag!))
    : all.filter(n => {
      const p = n.folder.join('/');
      return p === path || p.startsWith(path + '/');
    });

  const sorted = filtered.slice().sort((a, b) => b.updated_at.localeCompare(a.updated_at));

  const headerLabel = isAll ? 'All notes'
    : isPinned ? 'Pinned'
    : isRecent ? 'Recent'
    : isTag ? `#${tag}`
    : path.split('/').pop() ?? path;
  const breadcrumb = isAll || isPinned || isRecent ? 'Library'
    : isTag ? 'Tag'
    : (path.includes('/') ? path.split('/').slice(0, -1).join('/') : 'Folder');

  const onNew = async () => {
    const draft = newDraft();
    if (isReal) draft.folder = path.split('/');
    if (isTag) draft.tags = [tag!];
    session.notes.set(draft.id, draft);
    await saveNote(session, draft);
    router.push(`/note/${draft.id}`);
  };

  const onNoteLongPress = (n: Note) => {
    setActionSheet({
      title: n.title || 'Untitled',
      items: [
        { label: 'Open', icon: 'Note', onPress: () => router.push(`/note/${n.id}`) },
        { label: 'Copy title', icon: 'Copy', onPress: () => Clipboard.setStringAsync(n.title || 'Untitled') },
        { label: 'Copy markdown body', icon: 'Copy', onPress: () => Clipboard.setStringAsync(n.body) },
        { label: 'Delete note', icon: 'X', destructive: true, onPress: async () => {
          await deleteNote(session, n.id);
          force(x => x + 1);
        } },
      ],
    });
  };

  const onFolderActions = () => {
    if (!isReal) {
      Alert.alert('System view', 'This is a system view (All / Recent / Tag) — only real folders can be renamed or deleted.');
      return;
    }
    setActionSheet({
      title: path,
      items: [
        { label: 'Rename', icon: 'Edit', onPress: () => {
          setPrompt({
            title: 'Rename folder',
            initial: path.split('/').pop() ?? path,
            submit: async (raw) => {
              const name = raw.trim();
              if (!name || name.includes('/')) return;
              const parts = path.split('/');
              parts[parts.length - 1] = name;
              const newPath = parts.join('/');
              for (const n of all) {
                const p = n.folder.join('/');
                if (p === path || p.startsWith(path + '/')) {
                  const newFolder = newPath.split('/').concat(n.folder.slice(parts.length));
                  await saveNote(session, { ...n, folder: newFolder });
                }
              }
              const empties = await getEmptyFolders();
              await setEmptyFolders(empties.map(p =>
                p === path ? newPath : p.startsWith(path + '/') ? newPath + p.slice(path.length) : p,
              ));
              router.replace({ pathname: '/folder/[path]', params: { path: newPath } });
            },
          });
        } },
        { label: 'Delete folder', icon: 'X', destructive: true, onPress: async () => {
          for (const n of filtered) await deleteNote(session, n.id);
          const empties = await getEmptyFolders();
          await setEmptyFolders(empties.filter(p => p !== path && !p.startsWith(path + '/')));
          router.back();
        } },
      ],
    });
  };

  return (
    <View style={{ flex: 1, backgroundColor: MEO.paper }}>
      <ScrollView contentContainerStyle={{ paddingBottom: 100 }}>
        {/* Back nav */}
        <View style={{ paddingTop: 56, paddingHorizontal: 16, paddingBottom: 4, flexDirection: 'row', alignItems: 'center' }}>
          <Pressable onPress={() => router.back()} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <Icon.Back size={16} stroke={MEO.accent} />
            <Text style={{ color: MEO.accent, fontSize: 15, fontFamily: FONT_SANS }}>Folders</Text>
          </Pressable>
          <View style={{ flex: 1 }} />
          <Pressable onPress={() => setSearchOpen(true)} style={{ padding: 6, marginRight: 8 }}>
            <Icon.Search size={18} stroke={MEO.ink2} />
          </Pressable>
          <Pressable onPress={onFolderActions} style={{ padding: 6 }}>
            <Icon.Dots size={18} stroke={MEO.ink2} />
          </Pressable>
        </View>

        {/* Title */}
        <View style={{ padding: 20, paddingTop: 16 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 4 }}>
            <Icon.Folder size={11} stroke={MEO.accent} />
            <Text style={{ fontSize: 12, color: MEO.accent, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.8, fontFamily: FONT_SANS }}>
              {breadcrumb}
            </Text>
          </View>
          <Text style={{ fontFamily: FONT_SERIF, fontSize: 32, fontWeight: '700', letterSpacing: -0.5, color: MEO.ink }}>
            {headerLabel}
          </Text>
          <Text style={{ fontSize: 13, color: MEO.ink3, marginTop: 2, fontFamily: FONT_SANS }}>
            {filtered.length} {filtered.length === 1 ? 'note' : 'notes'}
          </Text>
        </View>

        {/* Notes card */}
        {sorted.length > 0 ? (
          <View style={{
            marginHorizontal: 16, marginBottom: 14,
            backgroundColor: MEO.card,
            borderRadius: 14,
            borderWidth: 1, borderColor: MEO.paperEdge,
            overflow: 'hidden',
          }}>
            {sorted.map((n, i) => (
              <View key={n.id}>
                <Row n={n}
                  onPress={() => router.push(`/note/${n.id}`)}
                  onLongPress={() => onNoteLongPress(n)}
                />
                {i < sorted.length - 1 && (
                  <View style={{ height: 0.5, backgroundColor: MEO.paperEdge, marginHorizontal: 14 }} />
                )}
              </View>
            ))}
          </View>
        ) : (
          <Text style={{
            fontFamily: FONT_SERIF, color: MEO.ink3, fontStyle: 'italic',
            textAlign: 'center', padding: 32,
          }}>No notes here yet.</Text>
        )}
      </ScrollView>

      {/* FAB */}
      <Pressable
        onPress={onNew}
        style={{
          position: 'absolute', bottom: 42, right: 20,
          width: 58, height: 58, borderRadius: 29,
          backgroundColor: MEO.ink, alignItems: 'center', justifyContent: 'center',
          shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 8, shadowOffset: { width: 0, height: 8 },
          elevation: 6,
        }}
      >
        <Icon.Edit size={22} stroke={MEO.paper} />
      </Pressable>

      {/* Modals */}
      <ActionSheet
        visible={!!actionSheet}
        title={actionSheet?.title}
        items={actionSheet?.items ?? []}
        onClose={() => setActionSheet(null)}
      />
      {prompt && (
        <PromptSheet
          visible
          title={prompt.title}
          initialValue={prompt.initial}
          onSubmit={prompt.submit}
          onClose={() => setPrompt(null)}
          submitLabel="Save"
        />
      )}
      <SearchOverlay
        visible={searchOpen}
        notes={all}
        folders={buildFolderTree(all)}
        onClose={() => setSearchOpen(false)}
        onSelectNote={(id) => router.push(`/note/${id}`)}
        onSelectFolder={(p) => router.push({ pathname: '/folder/[path]', params: { path: p } })}
        onSelectTag={(t) => router.push({ pathname: '/folder/[path]', params: { path: '_tag/' + t } })}
      />
    </View>
  );
}

function Row({ n, onPress, onLongPress }: { n: Note; onPress: () => void; onLongPress: () => void }) {
  const preview = (n.body.split('\n').find(l => l.trim() && !l.startsWith('#')) ?? '').slice(0, 200);
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={400}
      style={({ pressed }) => ({ padding: 14, backgroundColor: pressed ? MEO.paperDeep : 'transparent' })}
    >
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6, marginBottom: 2 }}>
        <Text style={{ fontSize: 15.5, fontWeight: '600', color: MEO.ink, flex: 1, fontFamily: FONT_SANS }} numberOfLines={1}>
          {n.title || 'Untitled'}
        </Text>
        <Text style={{ fontSize: 12, color: MEO.ink3, fontFamily: FONT_SANS }}>
          {timeAgo(n.updated_at)}
        </Text>
      </View>
      {preview ? (
        <Text style={{ fontSize: 13, color: MEO.ink3, lineHeight: 18, fontFamily: FONT_SANS }} numberOfLines={2}>
          {preview}
        </Text>
      ) : null}
      {n.tags.length > 0 && (
        <View style={{ flexDirection: 'row', gap: 4, marginTop: 4 }}>
          {n.tags.slice(0, 3).map(t => (
            <Text key={t} style={{ fontFamily: 'Menlo', fontSize: 11, color: MEO.ink3 }}>#{t}</Text>
          ))}
        </View>
      )}
    </Pressable>
  );
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'now';
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
