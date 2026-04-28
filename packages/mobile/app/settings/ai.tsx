// Settings → AI screen on mobile. Mirrors packages/desktop/src/Settings.tsx
// (Local models + Embeddings sections, Cloud locked v1.1).
//
// Phase 3.5 changes:
//   - Local models now lists llama.rn models with install / uninstall.
//   - First-time Qwen 2.5 1.5B install button (~950 MB, Wi-Fi-only by
//     default, resumable, progress bar).
//   - Apple FoundationModels visible-but-unavailable on iOS 18+ when
//     the native module isn't linked (the spec says "list as a
//     system-os model").
//   - Ollama section kept as a developer power-user fallback.

import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View, Text, ScrollView, Pressable, ActivityIndicator, Alert,
} from 'react-native';
import { router } from 'expo-router';
import { ai as A } from '../../src/shared';
import type { Model } from '../../src/shared/ai/types';
import { getSession } from '../../src/store';
import { peekAIRuntime, getAIRuntime } from '../../src/aiStore';
import { MEO, FONT_SANS, FONT_SERIF } from '../../src/theme';
import { Icon } from '../../src/Icon';

interface DownloadState {
  modelId: string;
  written: number;
  total: number;
  abort: AbortController;
}

export default function AISettingsScreen() {
  const session = getSession();
  const [ollamaModels, setOllamaModels] = useState<Model[]>([]);
  const [ollamaUp, setOllamaUp] = useState<boolean | null>(null);
  const [installed, setInstalled] = useState<Set<string>>(new Set());
  const [foundationCapable, setFoundationCapable] = useState(false);
  const [foundationAvailable, setFoundationAvailable] = useState(false);
  const [download, setDownload] = useState<DownloadState | null>(null);
  const downloadRef = useRef<DownloadState | null>(null);
  const [indexed, setIndexed] = useState<{ done: number; total: number } | null>(null);
  const [reindexing, setReindexing] = useState(false);

  // Refresh: probe ollama, foundation models, and which GGUFs are on disk.
  const refresh = useCallback(async () => {
    const ollama = new A.OllamaBackend();
    const ok = await ollama.isAvailable();
    setOllamaUp(ok);
    setOllamaModels(ok ? await ollama.listModels() : []);

    setFoundationCapable(A.isFoundationModelsCapable());
    setFoundationAvailable(await A.isFoundationModelsAvailable());

    const present = new Set<string>();
    for (const id of Object.keys(A.MODEL_FILES)) {
      if (await A.isModelInstalled(id)) present.add(id);
    }
    setInstalled(present);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (!session) return;
    const tick = async () => {
      const rt = peekAIRuntime();
      const total = session.notes.size;
      if (!rt) { setIndexed({ done: 0, total }); return; }
      const done = await rt.vectorStore.count();
      setIndexed({ done, total });
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [session]);

  const startInstall = useCallback(async (modelId: string) => {
    const entry = A.MODEL_FILES[modelId];
    if (!entry) return;
    const abort = new AbortController();
    const state: DownloadState = { modelId, written: 0, total: 0, abort };
    setDownload(state);
    downloadRef.current = state;
    try {
      const result = await A.downloadModel(modelId, (p) => {
        if (downloadRef.current && downloadRef.current.modelId === modelId) {
          const next = { ...downloadRef.current, written: p.written, total: p.total };
          downloadRef.current = next;
          setDownload(next);
        }
      }, abort.signal);
      if (!result.ok) {
        Alert.alert('Download failed', result.error);
      } else {
        await refresh();
      }
    } catch (e: any) {
      Alert.alert('Download failed', e?.message ?? String(e));
    } finally {
      if (downloadRef.current?.modelId === modelId) {
        downloadRef.current = null;
        setDownload(null);
      }
    }
  }, [refresh]);

  const cancelInstall = useCallback(() => {
    download?.abort.abort();
    downloadRef.current = null;
    setDownload(null);
  }, [download]);

  const uninstall = useCallback((modelId: string) => {
    Alert.alert(
      'Remove model?',
      `Delete the on-device GGUF file for "${modelId}". This frees disk space and is reversible by re-installing.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove', style: 'destructive', onPress: async () => {
            await A.deleteModel(modelId);
            await refresh();
          },
        },
      ],
    );
  }, [refresh]);

  const forceReindex = async () => {
    if (!session) return;
    setReindexing(true);
    try {
      const rt = await getAIRuntime();
      await rt.vectorStore.clear();
      await rt.rebuild(session.notes, (done, total) => setIndexed({ done, total }));
    } finally { setReindexing(false); }
  };

  if (!session) { router.replace('/'); return null; }

  return (
    <View style={{ flex: 1, backgroundColor: MEO.paper }}>
      {/* Header */}
      <View style={{ paddingTop: 56, paddingHorizontal: 16, paddingBottom: 6, flexDirection: 'row', alignItems: 'center' }}>
        <Pressable onPress={() => router.back()} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <Icon.Back size={16} stroke={MEO.accent} />
          <Text style={{ color: MEO.accent, fontSize: 15, fontFamily: FONT_SANS }}>Back</Text>
        </Pressable>
      </View>
      <Text style={{
        fontFamily: FONT_SERIF, fontSize: 28, fontWeight: '700',
        letterSpacing: -0.5, color: MEO.ink,
        paddingHorizontal: 20, paddingBottom: 6,
      }}>Settings · AI</Text>

      <ScrollView contentContainerStyle={{ paddingBottom: 80 }}>
        {/* ─── Local models (llama.rn / GGUF) ─── */}
        <Text style={SECTION_H}>Local models</Text>
        <Text style={SECTION_P}>
          Models run on this device with no internet. iOS uses Metal; Android uses Vulkan/OpenCL/CPU. Downloads are Wi-Fi only by default and resumable.
        </Text>

        <View style={{ marginHorizontal: 16, marginBottom: 14, backgroundColor: MEO.card, borderRadius: 14, borderWidth: 1, borderColor: MEO.paperEdge, overflow: 'hidden' }}>
          {A.LOCAL_GGUF_CATALOGUE.map((m, idx, arr) => {
            const isInstalled = installed.has(m.id);
            const dl = download?.modelId === m.id ? download : null;
            return (
              <View
                key={m.id}
                style={{
                  flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12,
                  borderBottomWidth: idx === arr.length - 1 ? 0 : 0.5,
                  borderBottomColor: MEO.paperEdge,
                }}
              >
                <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: isInstalled ? MEO.accent : MEO.ink3 }} />
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Text style={{ fontSize: 15, fontWeight: '600', color: MEO.ink, fontFamily: FONT_SANS }}>{m.name}</Text>
                    {m.default && (
                      <View style={{ paddingHorizontal: 5, paddingVertical: 1, borderRadius: 3, backgroundColor: MEO.paperDeep }}>
                        <Text style={{ fontSize: 9, fontWeight: '700', color: MEO.ink2, letterSpacing: 0.5, fontFamily: FONT_SANS }}>DEFAULT</Text>
                      </View>
                    )}
                  </View>
                  <Text style={{ fontSize: 11, color: MEO.ink3, marginTop: 1, fontFamily: FONT_SANS }}>
                    {[m.size, m.tag].filter(Boolean).join(' · ')}
                  </Text>
                  {dl && (
                    <View style={{ marginTop: 6, gap: 4 }}>
                      <View style={{ height: 4, backgroundColor: 'rgba(31,28,23,0.08)', borderRadius: 2, overflow: 'hidden' }}>
                        <View style={{
                          height: 4, backgroundColor: MEO.accent,
                          width: dl.total > 0 ? `${Math.min(100, (dl.written / dl.total) * 100)}%` : '5%',
                        }} />
                      </View>
                      <Text style={{ fontSize: 10.5, color: MEO.ink3, fontFamily: 'Menlo' }}>
                        {humanBytes(dl.written)}{dl.total ? ` / ${humanBytes(dl.total)}` : ''}
                      </Text>
                    </View>
                  )}
                </View>
                {isInstalled ? (
                  <Pressable onPress={() => uninstall(m.id)} style={SMALL_BTN}>
                    <Text style={SMALL_BTN_TEXT}>Remove</Text>
                  </Pressable>
                ) : dl ? (
                  <Pressable onPress={cancelInstall} style={SMALL_BTN}>
                    <Text style={SMALL_BTN_TEXT}>Cancel</Text>
                  </Pressable>
                ) : (
                  <Pressable
                    onPress={() => startInstall(m.id)}
                    disabled={!!download}
                    style={[SMALL_BTN, { opacity: download ? 0.4 : 1 }]}
                  >
                    <Text style={SMALL_BTN_TEXT}>Install{m.size ? ` (${m.size})` : ''}</Text>
                  </Pressable>
                )}
              </View>
            );
          })}
        </View>

        {/* ─── System-OS models (Apple FoundationModels) ─── */}
        {foundationCapable && (
          <>
            <Text style={SECTION_H}>System AI</Text>
            <Text style={SECTION_P}>
              Apple Intelligence runs in the OS — no download, no network. Available on iOS 18+ devices that support it.
            </Text>
            <View style={{ marginHorizontal: 16, marginBottom: 14, backgroundColor: MEO.card, borderRadius: 14, borderWidth: 1, borderColor: MEO.paperEdge, overflow: 'hidden' }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12 }}>
                <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: foundationAvailable ? MEO.accent : MEO.ink3 }} />
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 15, fontWeight: '600', color: MEO.ink, fontFamily: FONT_SANS }}>Apple Intelligence</Text>
                  <Text style={{ fontSize: 11, color: MEO.ink3, marginTop: 1, fontFamily: FONT_SANS }}>
                    {foundationAvailable ? 'Ready · iOS 18+' : 'Detected on this OS, native bridge not yet linked'}
                  </Text>
                </View>
                {foundationAvailable && <Icon.Check size={14} stroke="#3F5A2C" />}
              </View>
            </View>
          </>
        )}

        {/* ─── Ollama (developer fallback) ─── */}
        {(ollamaUp === true || ollamaModels.length > 0) && (
          <>
            <Text style={SECTION_H}>Ollama (developer)</Text>
            <Text style={SECTION_P}>
              Detected an Ollama daemon at localhost:11434. On a real phone this only works when the daemon is reachable on the LAN.
            </Text>
            <View style={{ marginHorizontal: 16, marginBottom: 14, backgroundColor: MEO.card, borderRadius: 14, borderWidth: 1, borderColor: MEO.paperEdge, overflow: 'hidden' }}>
              {ollamaModels.map(m => (
                <View key={m.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderBottomWidth: 0.5, borderBottomColor: MEO.paperEdge }}>
                  <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: MEO.accent }} />
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 15, fontWeight: '600', color: MEO.ink, fontFamily: FONT_SANS }}>{m.name}</Text>
                    <Text style={{ fontSize: 11, color: MEO.ink3, marginTop: 1, fontFamily: FONT_SANS }}>
                      {[m.size, m.tag].filter(Boolean).join(' · ')}
                    </Text>
                  </View>
                  <Icon.Check size={14} stroke="#3F5A2C" />
                </View>
              ))}
            </View>
          </>
        )}

        {/* ─── Embeddings ─── */}
        <Text style={SECTION_H}>Embeddings</Text>
        <Text style={SECTION_P}>
          Power Ask Meo's retrieval. Run locally on this device. Phase 3.5 ships scaffolding for a real bge-small embedder via onnxruntime-react-native, but the JS bundle still uses the no-op embedder for v1.0 — BM25 carries retrieval. See specs/05-llm-architecture.md §6.1 for the gap.
        </Text>

        <View style={{ marginHorizontal: 16, marginBottom: 14, backgroundColor: MEO.card, borderRadius: 14, borderWidth: 1, borderColor: MEO.paperEdge, padding: 14, gap: 8 }}>
          <Row label="Model" value={(peekAIRuntime()?.embedder.id) || 'noop'} />
          <Row label="Embeds" value="title + body + tags + folder" />
          <Row
            label="Indexed"
            value={indexed ? `${indexed.done} / ${indexed.total} notes` : 'not loaded'}
          />
          {indexed && indexed.total > 0 && (
            <View style={{ height: 4, backgroundColor: 'rgba(31,28,23,0.08)', borderRadius: 2, overflow: 'hidden' }}>
              <View style={{
                height: 4,
                backgroundColor: MEO.accent,
                width: `${Math.min(100, (indexed.done / indexed.total) * 100)}%`,
              }} />
            </View>
          )}
          <Pressable
            onPress={forceReindex}
            disabled={reindexing}
            style={{
              alignSelf: 'flex-start', paddingHorizontal: 14, paddingVertical: 8,
              borderRadius: 8, borderWidth: 1, borderColor: MEO.paperEdge,
              backgroundColor: MEO.paper,
              flexDirection: 'row', alignItems: 'center', gap: 6,
              marginTop: 4,
            }}
          >
            {reindexing && <ActivityIndicator size="small" color={MEO.ink2} />}
            <Text style={{ fontSize: 13, fontWeight: '600', color: MEO.ink, fontFamily: FONT_SANS }}>
              {reindexing ? 'Re-indexing…' : 'Force re-index'}
            </Text>
          </Pressable>
        </View>

        {/* ─── Cloud (locked) ─── */}
        <View style={{ paddingHorizontal: 22, paddingTop: 4, paddingBottom: 6, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={{ fontSize: 11, fontWeight: '600', color: MEO.ink3, textTransform: 'uppercase', letterSpacing: 0.8, fontFamily: FONT_SANS }}>Cloud models</Text>
          <View style={{ paddingHorizontal: 6, paddingVertical: 2, borderRadius: 3, backgroundColor: MEO.paperDeep }}>
            <Text style={{ fontSize: 9, fontWeight: '700', color: MEO.ink3, letterSpacing: 0.5, fontFamily: FONT_SANS }}>V1.1</Text>
          </View>
        </View>
        <Text style={[SECTION_P, { opacity: 0.55 }]}>
          Bring-your-own-key for OpenAI / Anthropic / Google. Sends note contents to the provider when used. Available on the paid tier.
        </Text>
      </ScrollView>
    </View>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View>
      <Text style={{
        fontSize: 11, fontWeight: '600', color: MEO.ink3,
        textTransform: 'uppercase', letterSpacing: 0.5, fontFamily: FONT_SANS,
      }}>{label}</Text>
      <Text style={{ fontSize: 13, color: MEO.ink, marginTop: 2, fontFamily: 'Menlo' }}>{value}</Text>
    </View>
  );
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

const SECTION_H = {
  paddingHorizontal: 22, paddingTop: 16, paddingBottom: 4,
  fontSize: 15, fontWeight: '600' as const, color: MEO.ink,
  fontFamily: FONT_SERIF, letterSpacing: -0.2,
};
const SECTION_P = {
  paddingHorizontal: 22, paddingBottom: 10,
  fontSize: 12.5, color: MEO.ink3, lineHeight: 18,
  fontFamily: FONT_SANS,
};
const SMALL_BTN = {
  paddingHorizontal: 12, paddingVertical: 7,
  borderRadius: 8, borderWidth: 1, borderColor: MEO.paperEdge,
  backgroundColor: MEO.paper,
};
const SMALL_BTN_TEXT = {
  fontSize: 12, fontWeight: '600' as const, color: MEO.ink, fontFamily: FONT_SANS,
};
