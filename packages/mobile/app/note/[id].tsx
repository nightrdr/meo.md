// Note editor on mobile. Plain markdown TextInput body (rich editor is
// deferred - TenTap was out of MVP scope per spec §5.2 and 04-mobile.md).
// Bottom toolbar matches the design source.

import { useEffect, useState, useCallback, useRef } from 'react';
import {
  View, TextInput, Pressable, Text, KeyboardAvoidingView, Platform, Alert, ScrollView,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { getSession } from '../../src/store';
import { saveNote, deleteNote } from '../../src/session';
import { MEO, FONT_SANS, FONT_SERIF, FONT_MONO } from '../../src/theme';
import { Icon } from '../../src/Icon';
import { ActionSheet, type ActionItem } from '../../src/ActionSheet';
import { AISheet } from '../../src/AISheet';
import * as Clipboard from 'expo-clipboard';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { uploadAttachment } from '../../src/attachmentsBridge';
import type { Note } from '../../src/shared';
import { ATTACHMENT_URL_PREFIX } from '../../src/shared/attachments';

export default function NoteEditor() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const session = getSession();
  const [note, setNote] = useState<Note | null>(null);
  const [tagInput, setTagInput] = useState('');
  const [showTagInput, setShowTagInput] = useState(false);
  const [status, setStatus] = useState<'saved' | 'saving' | 'error'>('saved');
  const [actionSheet, setActionSheet] = useState<{ title?: string; items: ActionItem[] } | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<{ kind: 'idle' } | { kind: 'busy'; filename: string } | { kind: 'error'; message: string }>({ kind: 'idle' });
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!session || !id) return;
    const n = session.notes.get(id);
    if (n) setNote(n);
    else router.back();
  }, [session, id]);

  const update = useCallback((patch: Partial<Note>) => {
    if (!note || !session) return;
    const next = { ...note, ...patch };
    setNote(next);
    session.notes.set(next.id, next);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      setStatus('saving');
      try {
        const saved = await saveNote(session, session.notes.get(next.id)!);
        session.notes.set(saved.id, saved);
        setStatus('saved');
      } catch { setStatus('error'); }
    }, 600);
  }, [note, session]);

  const openNoteActions = () => {
    if (!session || !note) return;
    setActionSheet({
      title: note.title || 'Untitled',
      items: [
        { label: 'Copy title', icon: 'Copy', onPress: () => Clipboard.setStringAsync(note.title || 'Untitled') },
        { label: 'Copy markdown body', icon: 'Copy', onPress: () => Clipboard.setStringAsync(note.body) },
        { label: 'Delete note', icon: 'X', destructive: true, onPress: async () => {
          await deleteNote(session, note.id);
          router.back();
        } },
      ],
    });
  };

  const addTag = () => {
    if (!note) return;
    const t = tagInput.trim().replace(/^#/, '').toLowerCase();
    setShowTagInput(false);
    setTagInput('');
    if (!t || note.tags.includes(t)) return;
    update({ tags: [...note.tags, t] });
  };
  const removeTag = (t: string) => {
    if (!note) return;
    update({ tags: note.tags.filter(x => x !== t) });
  };

  // ─── Attachment uploads (image + arbitrary file) ───
  const insertAttachmentMarkdown = useCallback((id: string, filename: string, isImage: boolean) => {
    if (!note) return;
    const url = `${ATTACHMENT_URL_PREFIX}${id}`;
    const md = isImage ? `\n\n![${filename}](${url})\n\n` : `\n[${filename}](${url})\n`;
    update({ body: note.body + md });
  }, [note, update]);

  const handleImagePick = useCallback(async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Permission needed', 'Please allow access to your photo library.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      base64: true,
      quality: 0.92,
    });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    const filename = asset.fileName || `image-${Date.now()}.jpg`;
    if (!asset.base64) {
      Alert.alert('Image error', 'Could not read image bytes.');
      return;
    }
    setUploadStatus({ kind: 'busy', filename });
    try {
      // Decode base64 → Uint8Array
      const bin = atob(asset.base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const dimensions = (asset.width && asset.height)
        ? { width: asset.width, height: asset.height }
        : undefined;
      const { id: noteId } = note!;
      const r = await uploadAttachment(noteId, {
        bytes, filename, mimeType: asset.mimeType ?? 'image/jpeg', dimensions,
      });
      insertAttachmentMarkdown(r.id, filename, true);
      setUploadStatus({ kind: 'idle' });
    } catch (e: any) {
      setUploadStatus({ kind: 'error', message: e?.message ?? String(e) });
    }
  }, [insertAttachmentMarkdown, note]);

  const handleDocumentPick = useCallback(async () => {
    const result = await DocumentPicker.getDocumentAsync({
      copyToCacheDirectory: true,
      multiple: false,
    });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    const filename = asset.name || `file-${Date.now()}`;
    setUploadStatus({ kind: 'busy', filename });
    try {
      const resp = await fetch(asset.uri);
      const buf = await resp.arrayBuffer();
      const bytes = new Uint8Array(buf);
      const r = await uploadAttachment(note!.id, {
        bytes, filename, mimeType: asset.mimeType ?? 'application/octet-stream',
      });
      const isImage = (asset.mimeType ?? '').startsWith('image/');
      insertAttachmentMarkdown(r.id, filename, isImage);
      setUploadStatus({ kind: 'idle' });
    } catch (e: any) {
      setUploadStatus({ kind: 'error', message: e?.message ?? String(e) });
    }
  }, [insertAttachmentMarkdown, note]);

  if (!note) return null;

  const folderLabel = note.folder.length ? note.folder.join('/') : 'Folders';

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: MEO.paper }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {/* Top nav */}
      <View style={{ paddingTop: 56, paddingHorizontal: 16, paddingBottom: 6, flexDirection: 'row', alignItems: 'center' }}>
        <Pressable onPress={() => router.back()} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <Icon.Back size={16} stroke={MEO.accent} />
          <Text style={{ color: MEO.accent, fontSize: 15, fontFamily: FONT_SANS }}>{folderLabel}</Text>
        </Pressable>
        <View style={{ flex: 1 }} />
        <View style={{ flexDirection: 'row', gap: 14 }}>
          <Pressable onPress={openNoteActions}>
            <Icon.Dots size={18} stroke={MEO.ink2} />
          </Pressable>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 22, paddingTop: 8, paddingBottom: 80 }}
        keyboardShouldPersistTaps="handled"
      >
        {/* Title */}
        <TextInput
          value={note.title}
          onChangeText={(t) => update({ title: t })}
          placeholder="Untitled"
          placeholderTextColor={MEO.ink4}
          style={{
            fontFamily: FONT_SERIF, fontSize: 30, fontWeight: '700',
            letterSpacing: -0.5, color: MEO.ink, marginBottom: 4,
          }}
          multiline
        />

        {/* Folder/path inline */}
        <TextInput
          value={note.folder.join('/')}
          onChangeText={(t) => update({ folder: t.split('/').map(s => s.trim()).filter(Boolean) })}
          placeholder="folder/path"
          placeholderTextColor={MEO.ink4}
          autoCapitalize="none"
          style={{
            fontFamily: FONT_MONO, fontSize: 12, color: MEO.ink3,
            paddingVertical: 4, marginBottom: 16,
          }}
        />

        {/* Body */}
        <TextInput
          value={note.body}
          onChangeText={(t) => update({ body: t })}
          placeholder="Start writing in markdown…"
          placeholderTextColor={MEO.ink4}
          multiline
          textAlignVertical="top"
          style={{
            fontFamily: FONT_SERIF, fontSize: 16.5, lineHeight: 27,
            color: MEO.ink, minHeight: 200,
          }}
        />

        {/* Tag chips */}
        <View style={{
          marginTop: 32, paddingTop: 16,
          borderTopWidth: StyleHairline(),
          borderTopColor: MEO.paperEdge,
          flexDirection: 'row', flexWrap: 'wrap', gap: 6,
        }}>
          {note.tags.map(t => (
            <View key={t} style={{
              flexDirection: 'row', alignItems: 'center', gap: 4,
              backgroundColor: MEO.accentSoft,
              paddingLeft: 8, paddingRight: 4, paddingVertical: 2,
              borderRadius: 4,
            }}>
              <Text style={{ fontFamily: FONT_MONO, fontSize: 11, color: MEO.accentInk }}>#{t}</Text>
              <Pressable onPress={() => removeTag(t)} style={{ padding: 2 }}>
                <Icon.X size={9} stroke={MEO.accentInk} />
              </Pressable>
            </View>
          ))}
          {showTagInput ? (
            <TextInput
              value={tagInput}
              onChangeText={setTagInput}
              onBlur={addTag}
              onSubmitEditing={addTag}
              autoFocus
              placeholder="tag"
              placeholderTextColor={MEO.ink4}
              autoCapitalize="none"
              style={{
                fontFamily: FONT_MONO, fontSize: 11,
                paddingHorizontal: 8, paddingVertical: 3,
                borderRadius: 4, borderWidth: 1, borderColor: MEO.accent,
                backgroundColor: MEO.overlay,
                minWidth: 80, color: MEO.ink,
              }}
            />
          ) : (
            <Pressable
              onPress={() => setShowTagInput(true)}
              style={{
                flexDirection: 'row', alignItems: 'center', gap: 4,
                paddingHorizontal: 8, paddingVertical: 3,
                borderRadius: 4, borderWidth: 1, borderStyle: 'dashed', borderColor: MEO.paperEdge,
              }}
            >
              <Icon.Plus size={10} stroke={MEO.ink3} />
              <Text style={{ fontFamily: FONT_MONO, fontSize: 11, color: MEO.ink3 }}>Add tag</Text>
            </Pressable>
          )}
        </View>
      </ScrollView>

      {/* Upload status banner */}
      {uploadStatus.kind !== 'idle' && (
        <View style={{
          paddingVertical: 8, paddingHorizontal: 16,
          borderTopWidth: 1, borderTopColor: MEO.paperEdge,
          backgroundColor: uploadStatus.kind === 'busy' ? MEO.accentSoft : 'rgba(196,85,63,0.10)',
          flexDirection: 'row', alignItems: 'center', gap: 8,
        }}>
          <Text style={{
            flex: 1, fontSize: 12.5,
            color: uploadStatus.kind === 'busy' ? MEO.accentInk : MEO.danger,
            fontFamily: FONT_SANS,
          }}>
            {uploadStatus.kind === 'busy'
              ? `Encrypting ${uploadStatus.filename}…`
              : `Upload error: ${uploadStatus.message}`}
          </Text>
          {uploadStatus.kind === 'error' && (
            <Pressable onPress={() => setUploadStatus({ kind: 'idle' })} hitSlop={8}>
              <Icon.X size={12} stroke={MEO.danger} />
            </Pressable>
          )}
        </View>
      )}

      {/* Bottom toolbar */}
      <View style={{
        borderTopWidth: 1, borderTopColor: MEO.paperEdge,
        paddingHorizontal: 14, paddingVertical: 10,
        flexDirection: 'row', alignItems: 'center', gap: 18,
        backgroundColor: 'rgba(246,242,234,0.92)',
      }}>
        <Pressable onPress={() => setAiOpen(true)}>
          <Icon.Sparkle size={19} stroke={MEO.ai} />
        </Pressable>
        <View style={{ width: 1, height: 18, backgroundColor: MEO.paperEdge }} />
        <Pressable onPress={handleImagePick} hitSlop={4}><Icon.Image size={19} stroke={MEO.ink2} /></Pressable>
        <Pressable onPress={handleDocumentPick} hitSlop={4}><Icon.Paperclip size={19} stroke={MEO.ink2} /></Pressable>
        <View style={{ width: 1, height: 18, backgroundColor: MEO.paperEdge }} />
        <Pressable onPress={() => insertAtEnd(note, update, '\n- [ ] ')}><Icon.Checklist size={19} stroke={MEO.ink2} /></Pressable>
        <Pressable onPress={() => insertAtEnd(note, update, '\n- ')}><Icon.List size={19} stroke={MEO.ink2} /></Pressable>
        <Pressable onPress={() => insertAtEnd(note, update, '\n## ')}><Icon.H1 size={19} stroke={MEO.ink2} /></Pressable>
        <Pressable onPress={() => wrap(note, update, '**')}><Icon.Bold size={19} stroke={MEO.ink2} /></Pressable>
        <Pressable onPress={() => wrap(note, update, '*')}><Icon.Italic size={19} stroke={MEO.ink2} /></Pressable>
        <View style={{ flex: 1 }} />
        <Text style={{ fontSize: 11, color: MEO.ink3, fontFamily: FONT_SANS }}>
          {status === 'saved' ? 'Saved' : status === 'saving' ? 'Saving…' : 'Save failed'}
        </Text>
      </View>

      <ActionSheet
        visible={!!actionSheet}
        title={actionSheet?.title}
        items={actionSheet?.items ?? []}
        onClose={() => setActionSheet(null)}
      />
      <AISheet
        visible={aiOpen}
        onClose={() => setAiOpen(false)}
        notes={session?.notes}
        modelId="qwen2.5:1.5b"
        noteId={note.id}
        noteTitle={note.title || 'Untitled'}
        onOpenNote={(id) => router.push(`/note/${id}`)}
      />
    </KeyboardAvoidingView>
  );
}

// ─── Helpers ───
function StyleHairline(): number {
  // ~0.5px on retina; iOS-style hairline. Fine for Android too.
  return 1 / (Platform.OS === 'ios' ? 2 : 1);
}
function insertAtEnd(note: Note, update: (p: Partial<Note>) => void, str: string) {
  update({ body: note.body + str });
}
function wrap(note: Note, update: (p: Partial<Note>) => void, marker: string) {
  // Simple: append "** **" for now. A real selection-aware wrap would need
  // the ref to the TextInput; this is the spec's MVP choice.
  update({ body: note.body + ` ${marker}${marker} ` });
}
