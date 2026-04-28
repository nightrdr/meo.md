// Mobile Ask Meo bottom sheet. Wired to the same RAG pipeline as
// desktop. Backend selection:
//
//   - Ollama at the configured endpoint (default: http://localhost:11434).
//     On a real phone localhost is the device itself, so this only
//     succeeds when Ollama is forwarded via the LAN — not common, but
//     supported for power users.
//   - llama.rn (phase 3.5, post-prebuild)
//   - Apple FoundationModels / Gemini Nano (phase 3.5)
//
// In v1.0 phase 3, the most likely state is "no backend reachable" — the
// sheet then surfaces a clear status card and the suggestions are
// placeholders.

import React, { useEffect, useState, useRef } from 'react';
import {
  Modal, View, Text, Pressable, TextInput, KeyboardAvoidingView, Platform,
  ScrollView, ActivityIndicator,
} from 'react-native';
import { ai as A } from './shared';
import type { Note } from './shared';
import { MEO, FONT_SANS, FONT_SERIF } from './theme';
import { Icon } from './Icon';
import { getAIRuntime } from './aiStore';

interface Message {
  role: 'user' | 'assistant';
  text: string;
  context?: A.RetrievedChunk[];
  pending?: boolean;
}

interface Props {
  visible: boolean;
  onClose: () => void;
  notes?: Map<string, Note>;
  modelId?: string;
  noteId?: string;
  noteTitle?: string;
  onOpenNote?: (id: string) => void;
}

const SUGGESTED = [
  { label: 'Summarize', icon: 'Sparkle' as const, q: 'Summarize my recent notes in 3 sentences.' },
  { label: 'Action items', icon: 'Checklist' as const, q: 'List action items across my notes as a checklist.' },
  { label: 'Find related', icon: 'List' as const, q: 'What are 3 themes that show up across my notes?' },
  { label: 'Reflect', icon: 'Edit' as const, q: 'What have I been writing about this week?' },
];

export function AISheet({ visible, onClose, notes, modelId, noteTitle, onOpenNote }: Props) {
  const [status, setStatus] = useState<'idle' | 'loading' | 'no-backend' | 'no-model' | 'ready' | 'error'>('idle');
  const [statusDetail, setStatusDetail] = useState('');
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // Probe runtime + Ollama availability when sheet opens
  useEffect(() => {
    if (!visible) return;
    setMessages([]);
    setStatus('loading');
    setStatusDetail('');
    (async () => {
      try {
        const rt = await getAIRuntime();
        const av = await rt.isAvailable();
        if (!av.ollama) {
          setStatus('no-backend');
          return;
        }
        if (modelId) {
          const models = await rt.generator.listModels();
          if (!models.some(m => m.id === modelId)) {
            setStatus('no-model');
            setStatusDetail(modelId);
            return;
          }
        }
        if (notes) {
          await rt.rebuild(notes);
        }
        setStatus('ready');
      } catch (e) {
        setStatus('error');
        setStatusDetail((e as Error).message);
      }
    })();
  }, [visible, modelId, notes]);

  const ask = async (q: string) => {
    if (!q.trim() || busy || !notes || !modelId) return;
    setInput('');
    setBusy(true);
    abortRef.current = new AbortController();

    setMessages(prev => [
      ...prev,
      { role: 'user', text: q },
      { role: 'assistant', text: '', pending: true },
    ]);

    try {
      const rt = await getAIRuntime();
      const result = await A.ragAsk({
        query: q,
        mode: 'ask',
        embedder: rt.embedder,
        vectorStore: rt.vectorStore,
        bm25: rt.bm25,
        notes,
        generator: rt.generator,
        modelId,
        signal: abortRef.current.signal,
      });

      setMessages(prev => prev.map((m, i) =>
        i === prev.length - 1 ? { ...m, context: result.context } : m,
      ));

      let acc = '';
      for await (const chunk of result.stream) {
        if (chunk.delta) {
          acc += chunk.delta;
          setMessages(prev => prev.map((m, i) =>
            i === prev.length - 1 ? { ...m, text: acc } : m,
          ));
        }
        if (chunk.done) {
          setMessages(prev => prev.map((m, i) =>
            i === prev.length - 1 ? { ...m, pending: false } : m,
          ));
        }
      }
      setMessages(prev => prev.map((m, i) =>
        i === prev.length - 1 ? { ...m, pending: false } : m,
      ));
    } catch (e) {
      setMessages(prev => prev.map((m, i) =>
        i === prev.length - 1 ? { ...m, text: `Error: ${(e as Error).message}`, pending: false } : m,
      ));
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(31,28,23,0.45)' }}
      >
        <Pressable onPress={onClose} style={{ flex: 1 }} />
        <View style={{
          backgroundColor: MEO.aiSoft,
          borderTopLeftRadius: 22, borderTopRightRadius: 22,
          borderTopWidth: 1, borderTopColor: 'rgba(180,99,42,0.25)',
          paddingTop: 8, paddingBottom: 24,
          maxHeight: '85%',
        }}>
          <View style={{
            alignSelf: 'center', width: 40, height: 4, borderRadius: 2,
            backgroundColor: 'rgba(180,99,42,0.3)', marginVertical: 8,
          }} />

          <View style={{ paddingHorizontal: 20, flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 }}>
            <Icon.Sparkle size={15} stroke={MEO.ai} />
            <Text style={{ flex: 1, fontSize: 15, fontWeight: '600', color: MEO.ai, fontFamily: FONT_SANS }}>
              Ask Meo
            </Text>
            <View style={{
              backgroundColor: '#fff', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10,
            }}>
              <Text style={{ fontSize: 11, color: MEO.ai, fontFamily: FONT_SANS }}>
                {noteTitle ? 'This note' : 'Workspace'}
              </Text>
            </View>
          </View>

          <ScrollView contentContainerStyle={{ paddingBottom: 20 }} keyboardShouldPersistTaps="handled">
            {status === 'loading' && (
              <Card><ActivityIndicator color={MEO.ai} /><Text style={cardP}>Loading runtime…</Text></Card>
            )}

            {status === 'no-backend' && (
              <Card>
                <Text style={cardH}>No on-device AI runtime yet</Text>
                <Text style={cardP}>
                  Mobile inference (llama.rn) requires <Text style={cardCode}>npx expo prebuild</Text> + a native build. The desktop app already runs local LLMs via Ollama and a hybrid retrieval pipeline (BM25 + vector + RRF) over your encrypted notes — same code path will run here once the native runtime is wired in.
                </Text>
              </Card>
            )}

            {status === 'no-model' && (
              <Card>
                <Text style={cardH}>Model not pulled</Text>
                <Text style={cardP}>
                  The selected model <Text style={cardCode}>{statusDetail}</Text> isn't available on the runtime. Pick a different one in Settings → AI.
                </Text>
              </Card>
            )}

            {status === 'error' && (
              <Card>
                <Text style={cardH}>Couldn't start AI</Text>
                <Text style={cardP}>{statusDetail}</Text>
              </Card>
            )}

            {status === 'ready' && messages.length === 0 && (
              <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
                <Text style={{
                  fontSize: 11, fontWeight: '600', color: MEO.ink3,
                  textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 8, fontFamily: FONT_SANS,
                }}>Suggested</Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                  {SUGGESTED.map(s => {
                    const I = Icon[s.icon];
                    return (
                      <Pressable
                        key={s.label}
                        onPress={() => ask(s.q)}
                        style={{
                          flexDirection: 'row', alignItems: 'center', gap: 6,
                          paddingHorizontal: 12, paddingVertical: 8, borderRadius: 20,
                          backgroundColor: '#fff',
                          borderWidth: 1, borderColor: '#E8D0A8',
                        }}
                      >
                        <I size={13} stroke={MEO.ai} />
                        <Text style={{ fontSize: 13, color: MEO.ink, fontFamily: FONT_SANS }}>{s.label}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            )}

            {messages.length > 0 && (
              <View style={{ paddingHorizontal: 16 }}>
                {messages.map((m, i) => (
                  <MessageView key={i} m={m} onOpenNote={onOpenNote ?? (() => {})} />
                ))}
              </View>
            )}
          </ScrollView>

          {/* Input bar */}
          <View style={{ paddingHorizontal: 12, paddingTop: 8 }}>
            <View style={{
              flexDirection: 'row', alignItems: 'center', gap: 8,
              backgroundColor: '#fff', borderRadius: 14,
              paddingLeft: 14, paddingRight: 6, height: 44,
              borderWidth: 1, borderColor: 'rgba(180,99,42,0.18)',
            }}>
              <TextInput
                value={input}
                onChangeText={setInput}
                onSubmitEditing={() => ask(input)}
                editable={status === 'ready' && !busy}
                placeholder={status === 'ready' ? 'Ask anything…' : 'Not available yet'}
                placeholderTextColor={MEO.ink3}
                style={{ flex: 1, fontSize: 14, color: MEO.ink, fontFamily: FONT_SANS, paddingVertical: 0 }}
              />
              {busy ? (
                <Pressable
                  onPress={() => abortRef.current?.abort()}
                  style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: MEO.danger, alignItems: 'center', justifyContent: 'center' }}
                >
                  <Icon.X size={11} stroke="#fff" />
                </Pressable>
              ) : (
                <Pressable
                  onPress={() => input.trim() && ask(input)}
                  disabled={status !== 'ready' || !input.trim()}
                  style={{
                    width: 32, height: 32, borderRadius: 16,
                    backgroundColor: status === 'ready' && input.trim() ? MEO.ai : 'rgba(180,99,42,0.4)',
                    alignItems: 'center', justifyContent: 'center',
                  }}
                >
                  <Icon.ArrowUp size={14} stroke="#fff" />
                </Pressable>
              )}
            </View>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ─── Sub-components + style helpers ───

function Card({ children }: any) {
  return (
    <View style={{
      margin: 16, marginTop: 12, padding: 14, borderRadius: 14,
      backgroundColor: '#fff', borderWidth: 1, borderColor: '#E8D0A8',
      flexDirection: 'row', gap: 10, alignItems: 'flex-start',
    }}>
      <View style={{ flex: 1 }}>{children}</View>
    </View>
  );
}
const cardH = { fontSize: 13.5, fontWeight: '600' as const, color: MEO.ink, marginBottom: 6, fontFamily: FONT_SANS };
const cardP = { fontSize: 13, color: MEO.ink2, lineHeight: 19, fontFamily: FONT_SERIF, fontStyle: 'italic' as const };
const cardCode = { fontFamily: 'Menlo', fontSize: 12, color: MEO.ink, backgroundColor: 'rgba(31,28,23,0.06)', paddingHorizontal: 4, fontStyle: 'normal' as const };

function MessageView({ m, onOpenNote }: { m: Message; onOpenNote: (id: string) => void }) {
  if (m.role === 'user') {
    return (
      <View style={{
        alignSelf: 'flex-end',
        maxWidth: '85%', padding: 9, paddingHorizontal: 12, marginVertical: 6, marginLeft: 32,
        borderRadius: 12, borderBottomRightRadius: 3,
        backgroundColor: '#fff', borderWidth: 1, borderColor: '#E8D0A8',
      }}>
        <Text style={{ fontSize: 13, color: MEO.ink2, fontFamily: FONT_SANS }}>{m.text}</Text>
      </View>
    );
  }

  const { clean, ids } = A.extractCitations(m.text);
  return (
    <View style={{ marginVertical: 6, marginRight: 16 }}>
      {m.context && m.context.length > 0 && (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
          <Text style={{ fontSize: 11, color: MEO.ink3, fontFamily: FONT_SANS }}>Context: </Text>
          {m.context.slice(0, 3).map(c => (
            <Pressable key={c.noteId} onPress={() => onOpenNote(c.noteId)}
              style={{
                paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4,
                backgroundColor: 'rgba(180,99,42,0.12)',
              }}
            >
              <Text style={{ fontSize: 11, color: MEO.ai, fontFamily: FONT_SANS, fontWeight: '500' }}>{c.title}</Text>
            </Pressable>
          ))}
        </View>
      )}
      <View style={{
        backgroundColor: '#fff', borderRadius: 12, borderTopLeftRadius: 4,
        padding: 12, borderWidth: 1, borderColor: '#E8D0A8',
      }}>
        <Text style={{ fontFamily: FONT_SERIF, fontSize: 13.5, color: MEO.ink, lineHeight: 21 }}>
          {clean}{m.pending ? ' ▍' : ''}
        </Text>
      </View>
      {ids.length > 0 && (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
          {ids.map((id, i) => (
            <Pressable key={id} onPress={() => onOpenNote(id)}>
              <Text style={{ fontSize: 11, color: MEO.ink3, fontFamily: 'Menlo', padding: 2 }}>
                [{i + 1}] open source
              </Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}
