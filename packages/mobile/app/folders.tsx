// Top-level mobile screen. Brand + AI sparkle, search, system folders
// card (All / Pinned / Recent), USER FOLDERS card, FAB. Long-press a
// folder/tag for context actions; tap "+" in the FOLDERS section header
// to create a new folder.

import { useEffect, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, Pressable, RefreshControl,
} from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { getSession, setSession } from '../src/store';
import {
  rehydrate, pullSync, getEmptyFolders, setEmptyFolders,
  buildFolderTree, buildTagList, newDraft, saveNote, deleteNote,
} from '../src/session';
import { MEO, FONT_SANS, FONT_SERIF, alpha } from '../src/theme';
import { MeoMark, Icon } from '../src/Icon';
import { ActionSheet, PromptSheet, type ActionItem } from '../src/ActionSheet';
import { SearchOverlay } from '../src/SearchOverlay';
import { AISheet } from '../src/AISheet';

export default function FoldersScreen() {
  const session = getSession();
  const [, force] = useState(0);
  const [emptyFolders, setEmptyFoldersState] = useState<string[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [actionSheet, setActionSheet] = useState<{ title?: string; items: ActionItem[] } | null>(null);
  const [prompt, setPrompt] = useState<{ title: string; placeholder?: string; initial?: string; submit: (v: string) => void } | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);

  useEffect(() => {
    if (!session) { router.replace('/'); return; }
    (async () => {
      await rehydrate(session);
      setEmptyFoldersState(await getEmptyFolders());
      force(x => x + 1);
      try { await pullSync(session); force(x => x + 1); } catch {}
    })();
  }, [session]);

  useFocusEffect(useCallback(() => { force(x => x + 1); }, []));
  if (!session) return null;

  const all = Array.from(session.notes.values());
  const folderTree = buildFolderTree(all, emptyFolders).filter(f => f.path !== '');
  const topLevel = folderTree.filter(({ path }) => !path.includes('/'));
  const tagList = buildTagList(all);
  const recentCount = all.length;

  // ─── Actions ───
  const onRefresh = async () => {
    setRefreshing(true);
    try { await pullSync(session); force(x => x + 1); } catch {}
    setRefreshing(false);
  };

  const onNew = async () => {
    const draft = newDraft();
    session.notes.set(draft.id, draft);
    await saveNote(session, draft);
    router.push(`/note/${draft.id}`);
  };

  const persistEmptyFolders = async (next: string[]) => {
    setEmptyFoldersState(next);
    await setEmptyFolders(next);
  };

  const startCreateFolder = (parent: string | null) => {
    setPrompt({
      title: parent ? `New sub-folder in "${parent}"` : 'New folder',
      placeholder: 'Folder name',
      submit: async (raw) => {
        const name = raw.trim();
        if (!name || name.includes('/')) return;
        const fullPath = parent ? `${parent}/${name}` : name;
        if (folderTree.some(f => f.path === fullPath)) {
          router.push({ pathname: '/folder/[path]', params: { path: fullPath } });
          return;
        }
        await persistEmptyFolders([...emptyFolders, fullPath]);
        router.push({ pathname: '/folder/[path]', params: { path: fullPath } });
      },
    });
  };

  const handleDeleteFolder = async (path: string) => {
    const affected = all.filter(n => {
      const p = n.folder.join('/');
      return p === path || p.startsWith(path + '/');
    });
    setActionSheet({
      title: affected.length
        ? `Delete folder "${path}" and ${affected.length} note${affected.length === 1 ? '' : 's'}?`
        : `Delete empty folder "${path}"?`,
      items: [
        {
          label: 'Delete', icon: 'X', destructive: true,
          onPress: async () => {
            for (const n of affected) await deleteNote(session, n.id);
            await persistEmptyFolders(emptyFolders.filter(p => p !== path && !p.startsWith(path + '/')));
            force(x => x + 1);
          },
        },
      ],
    });
  };

  const folderLongPress = (path: string) => {
    const items: ActionItem[] = [
      { label: 'Open', icon: 'Folder', onPress: () => router.push({ pathname: '/folder/[path]', params: { path } }) },
      { label: 'New note here', icon: 'Plus', onPress: async () => {
        const draft = newDraft();
        draft.folder = path.split('/');
        session.notes.set(draft.id, draft);
        await saveNote(session, draft);
        router.push(`/note/${draft.id}`);
      } },
      { label: 'New sub-folder', icon: 'Folder', onPress: () => startCreateFolder(path) },
      { label: 'Rename', icon: 'Edit', onPress: () => {
        // Rename only the leaf segment; rewrites every affected note.
        const leaf = path.split('/').pop() ?? path;
        setPrompt({
          title: 'Rename folder',
          initial: leaf,
          placeholder: 'Folder name',
          submit: async (raw) => {
            const name = raw.trim();
            if (!name || name === leaf || name.includes('/')) return;
            const parts = path.split('/');
            parts[parts.length - 1] = name;
            const newPath = parts.join('/');
            // Rewrite notes
            for (const n of all) {
              const p = n.folder.join('/');
              if (p === path || p.startsWith(path + '/')) {
                const newFolder = newPath.split('/').concat(n.folder.slice(parts.length));
                await saveNote(session, { ...n, folder: newFolder });
              }
            }
            // Rewrite empty folders
            await persistEmptyFolders(emptyFolders.map(p =>
              p === path ? newPath : p.startsWith(path + '/') ? newPath + p.slice(path.length) : p,
            ));
            force(x => x + 1);
          },
        });
      } },
      { label: 'Delete folder', icon: 'X', destructive: true, onPress: () => handleDeleteFolder(path) },
    ];
    setActionSheet({ title: path, items });
  };

  const tagLongPress = (tag: string) => {
    setActionSheet({
      title: `#${tag}`,
      items: [
        { label: 'Filter notes', icon: 'Tag', onPress: () => router.push({ pathname: '/folder/[path]', params: { path: `_tag/${tag}` } }) },
        { label: `Remove "#${tag}" from all notes`, icon: 'X', destructive: true, onPress: async () => {
          for (const n of all) {
            if (n.tags.includes(tag)) await saveNote(session, { ...n, tags: n.tags.filter(t => t !== tag) });
          }
          force(x => x + 1);
        } },
      ],
    });
  };

  const onSignOut = () => {
    setActionSheet({
      title: 'Sign out?',
      items: [
        { label: 'Sign out', icon: 'Eject', destructive: true, onPress: () => {
          setSession(null);
          router.replace('/');
        } },
      ],
    });
  };

  // ─── Render ───
  return (
    <View style={{ flex: 1, backgroundColor: MEO.paper }}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: 100 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        {/* Brand row */}
        <View style={{ paddingTop: 64, paddingHorizontal: 20, paddingBottom: 14, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <MeoMark size={28} />
          <Text style={{ fontFamily: FONT_SERIF, fontSize: 28, fontWeight: '700', letterSpacing: -0.5, color: MEO.ink, flex: 1 }}>
            Meo
          </Text>
          <Pressable
            onPress={() => setAiOpen(true)}
            style={{
              width: 36, height: 36, borderRadius: 18,
              backgroundColor: alpha(MEO.ink, 0.06),
              alignItems: 'center', justifyContent: 'center',
            }}
          >
            <Icon.Sparkle size={15} stroke={MEO.ai} />
          </Pressable>
          <Pressable
            onPress={() => router.push('/settings/ai')}
            style={{ marginLeft: 4, padding: 6 }}
          >
            <Icon.Settings size={16} stroke={MEO.ink2} />
          </Pressable>
          <Pressable onPress={onSignOut} style={{ marginLeft: 2, padding: 6 }}>
            <Icon.Eject size={16} stroke={MEO.ink2} />
          </Pressable>
        </View>

        {/* Search */}
        <View style={{ paddingHorizontal: 16, paddingBottom: 18 }}>
          <Pressable
            onPress={() => setSearchOpen(true)}
            style={{
              height: 40, borderRadius: 10,
              backgroundColor: alpha(MEO.ink, 0.05),
              flexDirection: 'row', alignItems: 'center',
              paddingHorizontal: 12, gap: 8,
            }}
          >
            <Icon.Search size={15} stroke={MEO.ink3} />
            <Text style={{ fontSize: 15, color: MEO.ink3, fontFamily: FONT_SANS }}>Search notes & ask Meo</Text>
          </Pressable>
        </View>

        {/* System folders card */}
        <Card>
          <SystemRow icon="Note" tint={MEO.accent} label="All notes" count={all.length}
            onPress={() => router.push('/folder/_all')} />
          <Divider />
          <SystemRow icon="Star" tint="#C8A15A" label="Recent" count={recentCount}
            onPress={() => router.push('/folder/_recent')} />
        </Card>

        {/* User folders */}
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 22, paddingTop: 4, paddingBottom: 6 }}>
          <Text style={{
            flex: 1, fontSize: 11, fontWeight: '600', color: MEO.ink3,
            textTransform: 'uppercase', letterSpacing: 0.8, fontFamily: FONT_SANS,
          }}>Folders</Text>
          <Pressable onPress={() => startCreateFolder(null)} style={{ padding: 4 }}>
            <Icon.Plus size={14} stroke={MEO.ink3} />
          </Pressable>
        </View>
        {topLevel.length > 0 ? (
          <Card>
            {topLevel.map((f, i) => (
              <View key={f.path}>
                <FolderRow
                  label={f.path.split('/').pop() ?? f.path}
                  count={f.count}
                  onPress={() => router.push({ pathname: '/folder/[path]', params: { path: f.path } })}
                  onLongPress={() => folderLongPress(f.path)}
                />
                {i < topLevel.length - 1 && <Divider />}
              </View>
            ))}
          </Card>
        ) : (
          <Pressable
            onPress={() => startCreateFolder(null)}
            style={{
              marginHorizontal: 16, marginBottom: 14,
              padding: 16, borderRadius: 14,
              borderWidth: 1, borderStyle: 'dashed', borderColor: MEO.paperEdge,
              alignItems: 'center', backgroundColor: 'transparent',
            }}
          >
            <Text style={{ fontFamily: FONT_SERIF, fontStyle: 'italic', color: MEO.ink3, fontSize: 14 }}>Tap to create your first folder</Text>
          </Pressable>
        )}

        {/* Tag chips */}
        {tagList.length > 0 && (
          <>
            <Text style={{
              paddingHorizontal: 22, paddingTop: 4, paddingBottom: 6,
              fontSize: 11, fontWeight: '600', color: MEO.ink3,
              textTransform: 'uppercase', letterSpacing: 0.8, fontFamily: FONT_SANS,
            }}>Tags</Text>
            <View style={{ paddingHorizontal: 16, flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {tagList.map(t => (
                <Pressable
                  key={t.tag}
                  onPress={() => router.push({ pathname: '/folder/[path]', params: { path: '_tag/' + t.tag } })}
                  onLongPress={() => tagLongPress(t.tag)}
                  style={{
                    backgroundColor: MEO.paperDeep,
                    paddingHorizontal: 10, paddingVertical: 4,
                    borderRadius: 6,
                    flexDirection: 'row', alignItems: 'center', gap: 5,
                  }}
                >
                  <Text style={{ fontFamily: 'Menlo', fontSize: 12, color: MEO.ink2 }}>#{t.tag}</Text>
                  <Text style={{ fontSize: 10, color: MEO.ink3 }}>{t.count}</Text>
                </Pressable>
              ))}
            </View>
          </>
        )}
      </ScrollView>

      {/* FAB */}
      <Pressable
        onPress={onNew}
        style={{
          position: 'absolute', bottom: 42, right: 20,
          width: 58, height: 58, borderRadius: 29,
          backgroundColor: MEO.ink,
          alignItems: 'center', justifyContent: 'center',
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
          placeholder={prompt.placeholder}
          initialValue={prompt.initial}
          submitLabel="Save"
          onSubmit={prompt.submit}
          onClose={() => setPrompt(null)}
        />
      )}
      <SearchOverlay
        visible={searchOpen}
        notes={all}
        folders={folderTree}
        onClose={() => setSearchOpen(false)}
        onSelectNote={(id) => router.push(`/note/${id}`)}
        onSelectFolder={(path) => router.push({ pathname: '/folder/[path]', params: { path } })}
        onSelectTag={(tag) => router.push({ pathname: '/folder/[path]', params: { path: '_tag/' + tag } })}
      />
      <AISheet
        visible={aiOpen}
        onClose={() => setAiOpen(false)}
        notes={session.notes}
        modelId="qwen2.5:1.5b"
        onOpenNote={(id) => router.push(`/note/${id}`)}
      />
    </View>
  );
}

// ─── Building blocks ───

function Card({ children }: any) {
  return (
    <View style={{
      marginHorizontal: 16, marginBottom: 14,
      backgroundColor: MEO.card,
      borderRadius: 14,
      borderWidth: 1, borderColor: MEO.paperEdge,
      overflow: 'hidden',
    }}>{children}</View>
  );
}
function Divider() {
  return <View style={{ height: 0.5, backgroundColor: MEO.paperEdge, marginHorizontal: 14 }} />;
}
function SystemRow({ icon, tint, label, count, onPress }: { icon: keyof typeof Icon; tint: string; label: string; count: number; onPress: () => void }) {
  const I = Icon[icon];
  return (
    <Pressable onPress={onPress} style={{ flexDirection: 'row', alignItems: 'center', padding: 12, gap: 12 }}>
      <View style={{
        width: 30, height: 30, borderRadius: 7,
        backgroundColor: tint + '22',
        alignItems: 'center', justifyContent: 'center',
      }}>
        <I size={15} stroke={tint} />
      </View>
      <Text style={{ flex: 1, fontSize: 16, color: MEO.ink, fontWeight: '500', fontFamily: FONT_SANS }}>{label}</Text>
      <Text style={{ fontSize: 14, color: MEO.ink3, fontFamily: FONT_SANS }}>{count}</Text>
      <Icon.Chevron size={13} stroke={MEO.ink3} />
    </Pressable>
  );
}
function FolderRow({ label, count, onPress, onLongPress }: { label: string; count: number; onPress: () => void; onLongPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={400}
      style={{ flexDirection: 'row', alignItems: 'center', padding: 12, gap: 12 }}
    >
      <Icon.Folder size={17} stroke={MEO.accent} />
      <Text style={{ flex: 1, fontSize: 16, color: MEO.ink, fontWeight: '500', fontFamily: FONT_SANS }}>{label}</Text>
      <Text style={{ fontSize: 14, color: MEO.ink3, fontFamily: FONT_SANS }}>{count}</Text>
      <Icon.Chevron size={13} stroke={MEO.ink3} />
    </Pressable>
  );
}
