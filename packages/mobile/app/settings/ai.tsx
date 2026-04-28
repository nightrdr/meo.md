// Settings → AI screen on mobile. Mirrors packages/desktop/src/Settings.tsx
// (Local models + Embeddings sections, Cloud locked v1.1).

import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, Pressable, ActivityIndicator,
} from 'react-native';
import { router } from 'expo-router';
import { ai as A } from '../../src/shared';
import type { Model } from '../../src/shared/ai/types';
import { getSession } from '../../src/store';
import { peekAIRuntime, getAIRuntime } from '../../src/aiStore';
import { MEO, FONT_SANS, FONT_SERIF } from '../../src/theme';
import { Icon } from '../../src/Icon';

export default function AISettingsScreen() {
  const session = getSession();
  const [discovered, setDiscovered] = useState<Model[]>([]);
  const [ollamaUp, setOllamaUp] = useState<boolean | null>(null);
  const [indexed, setIndexed] = useState<{ done: number; total: number } | null>(null);
  const [reindexing, setReindexing] = useState(false);

  const refresh = useCallback(async () => {
    const backend = new A.OllamaBackend();
    const ok = await backend.isAvailable();
    setOllamaUp(ok);
    if (ok) setDiscovered(await backend.listModels());
    else setDiscovered([]);
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
        {/* ─── Local models ─── */}
        <Text style={SECTION_H}>Local models</Text>
        <Text style={SECTION_P}>
          Models run on this device with no internet. Mobile uses llama.rn after `npx expo prebuild` (phase 3.5). For now, this lists Ollama models if a local daemon is reachable.
        </Text>

        {ollamaUp === false && (
          <View style={CALLOUT}>
            <Icon.Sparkle size={13} stroke={MEO.ai} />
            <Text style={CALLOUT_TEXT}>
              No on-device LLM runtime available yet. The desktop app uses Ollama; mobile will use llama.rn after the next major build.
            </Text>
          </View>
        )}

        {discovered.length > 0 && (
          <View style={{ marginHorizontal: 16, marginBottom: 14, backgroundColor: MEO.card, borderRadius: 14, borderWidth: 1, borderColor: MEO.paperEdge, overflow: 'hidden' }}>
            {discovered.map(m => (
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
        )}

        {/* ─── Embeddings ─── */}
        <Text style={SECTION_H}>Embeddings</Text>
        <Text style={SECTION_P}>
          Power Ask Meo's retrieval. Run locally on this device. v1.0 mobile ships a no-op embedder so BM25 carries retrieval; the real bge-small embedder lands in phase 3.5.
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
const CALLOUT = {
  marginHorizontal: 16, marginBottom: 12,
  padding: 12, borderRadius: 8,
  backgroundColor: MEO.aiSoft,
  borderWidth: 1, borderColor: '#E8C4B7',
  flexDirection: 'row' as const, gap: 10, alignItems: 'flex-start' as const,
};
const CALLOUT_TEXT = {
  flex: 1, fontSize: 12.5, color: '#923524', lineHeight: 18,
  fontFamily: FONT_SANS,
};
