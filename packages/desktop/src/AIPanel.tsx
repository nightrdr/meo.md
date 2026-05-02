import React, { useState, useEffect, useRef, useCallback } from 'react';
import { ai as A, type Note } from '@meo/shared';
import { Icon } from './Icon';
import { getAIRuntime } from './aiStore';

interface Message {
  role: 'user' | 'assistant';
  text: string;
  context?: A.RetrievedChunk[];      // assistant-only
  pending?: boolean;
}

type Mode = 'ask' | 'chat';

interface Props {
  notes: Map<string, Note>;
  modelId: string;
  onClose: () => void;
  onOpenNote: (id: string) => void;
}

const SUGGESTED = [
  { icon: 'Sparkle' as const, label: 'Summarize this workspace', q: 'Give a 3-bullet summary of my recent notes.' },
  { icon: 'Checklist' as const, label: 'Extract action items', q: 'List all open action items across my notes as a checklist.' },
  { icon: 'Link' as const, label: 'Find related notes', q: 'What are 3 themes that appear across my notes?' },
  { icon: 'Quote' as const, label: 'Reflect on this week', q: 'What have I been writing about this week?' },
];

export function AIPanel({ notes, modelId, onClose, onOpenNote }: Props) {
  const [mode, setMode] = useState<Mode>('ask');
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<'loading-runtime' | 'no-ollama' | 'no-model' | 'ready' | 'error'>('loading-runtime');
  const [statusDetail, setStatusDetail] = useState<string>('');
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Probe runtime + Ollama availability once on mount
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const rt = await getAIRuntime();
        if (!alive) return;
        const av = await rt.isAvailable();
        if (!av.ollama) { setStatus('no-ollama'); return; }
        // Make sure the chosen model id is actually pulled in Ollama
        const models = await rt.generator.listModels();
        if (!models.some(m => m.id === modelId)) {
          setStatus('no-model');
          setStatusDetail(modelId);
          return;
        }
        // First-time: build BM25 + embeddings for all notes in the background
        await rt.rebuild(notes);
        setStatus('ready');
      } catch (e) {
        setStatus('error');
        setStatusDetail((e as Error).message);
      }
    })();
    return () => { alive = false; };
    // We deliberately don't depend on notes here - rebuild is idempotent
    // and re-runs only on dep change (we'll handle hot updates separately).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelId]);

  // Auto-scroll to bottom on new content
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  const ask = useCallback(async (q: string) => {
    if (!q.trim() || busy) return;
    setInput('');
    setBusy(true);
    abortRef.current = new AbortController();

    const userMsg: Message = { role: 'user', text: q };
    const assistantMsg: Message = { role: 'assistant', text: '', pending: true };
    setMessages(prev => [...prev, userMsg, assistantMsg]);

    try {
      const rt = await getAIRuntime();
      const history = mode === 'chat'
        ? messages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.text }))
        : undefined;
      const result = await A.ragAsk({
        query: q,
        mode,
        history,
        embedder: rt.embedder,
        vectorStore: rt.vectorStore,
        bm25: rt.bm25,
        notes,
        generator: rt.generator,
        modelId,
        signal: abortRef.current.signal,
      });

      // Set retrieved context immediately so the UI can show "Looking at N notes…"
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
      const err = (e as Error).message;
      if (err.includes('aborted') || err.includes('AbortError')) {
        setMessages(prev => prev.map((m, i) =>
          i === prev.length - 1 ? { ...m, text: m.text + '\n\n(stopped)', pending: false } : m,
        ));
      } else {
        setMessages(prev => prev.map((m, i) =>
          i === prev.length - 1 ? { ...m, text: `Error: ${err}`, pending: false } : m,
        ));
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }, [busy, mode, messages, notes, modelId]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  // ─── Render ───
  return (
    <aside className="ai-panel">
      <header className="ai-panel-header">
        <Icon.Sparkle size={14} stroke="var(--ai)" />
        <span className="ai-panel-title">Ask Meo</span>
        <span className="ai-panel-scope">Scope: workspace</span>
        <button className="btn icon-btn small" onClick={onClose} title="Close">
          <Icon.X size={12} />
        </button>
      </header>

      <div className="ai-panel-modes">
        <div className="ai-mode-segment">
          {(['ask', 'chat'] as Mode[]).map(m => (
            <button
              key={m}
              type="button"
              className={mode === m ? 'on' : ''}
              onClick={() => setMode(m)}
            >{m === 'ask' ? 'Ask' : 'Chat'}</button>
          ))}
        </div>
        <span className="ai-mode-help">
          {mode === 'ask' ? 'Single answer with citations' : 'Conversation, each turn re-retrieves'}
        </span>
      </div>

      <div className="ai-panel-body" ref={scrollRef}>
        {status === 'loading-runtime' && (
          <StatusCard kind="info" title="Loading">
            Embedding model is loading. First time can take a moment.
          </StatusCard>
        )}
        {status === 'no-ollama' && (
          <StatusCard kind="warn" title="Ollama is not running">
            <p>meo.md uses Ollama for local LLMs. Install it from <a href="https://ollama.com/download" target="_blank" rel="noreferrer">ollama.com/download</a> and start it.</p>
            <p className="muted">After installing, run <code className="kbd">ollama pull qwen2.5:1.5b</code> in your terminal, then reload Meo.</p>
          </StatusCard>
        )}
        {status === 'no-model' && (
          <StatusCard kind="warn" title="Model not pulled">
            <p>Ollama is running but doesn't have <code className="kbd">{statusDetail}</code> yet. Run:</p>
            <pre className="codeblock">ollama pull {statusDetail.replace(/-q4$/, '')}</pre>
            <p className="muted">Then pick a model in the sidebar.</p>
          </StatusCard>
        )}
        {status === 'error' && (
          <StatusCard kind="error" title="Couldn't start AI">
            {statusDetail}
          </StatusCard>
        )}

        {status === 'ready' && messages.length === 0 && (
          <div className="ai-suggested">
            <div className="ai-section-h">Suggested</div>
            {SUGGESTED.map((s, i) => {
              const I = Icon[s.icon];
              return (
                <button key={i} className="ai-suggestion" type="button" onClick={() => ask(s.q)}>
                  <I size={13} stroke="var(--ai)" />
                  <span>{s.label}</span>
                </button>
              );
            })}
          </div>
        )}

        {messages.length > 0 && (
          <div className="ai-conversation">
            {status !== 'ready' && messages.length > 0 && (
              <div className="ai-section-h">Conversation</div>
            )}
            {messages.map((m, i) => (
              <MessageView key={i} m={m} onOpenNote={onOpenNote} />
            ))}
          </div>
        )}
      </div>

      <footer className="ai-panel-input-row">
        <div className="ai-input-shell">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(input); }
            }}
            placeholder={mode === 'ask' ? 'Ask about your notes…' : 'Continue the conversation…'}
            disabled={status !== 'ready'}
          />
          {busy ? (
            <button type="button" className="ai-stop-btn" onClick={stop} title="Stop">
              <Icon.X size={11} stroke="#fff" />
            </button>
          ) : (
            <button
              type="button"
              className="ai-send-btn"
              disabled={!input.trim() || status !== 'ready'}
              onClick={() => ask(input)}
              title="Send"
            >
              <Icon.Plus size={12} stroke="#fff" style={{ transform: 'rotate(45deg) translate(0px, -1px)' }} />
            </button>
          )}
        </div>
      </footer>
    </aside>
  );
}

// ─── Sub-components ───

function MessageView({ m, onOpenNote }: { m: Message; onOpenNote: (id: string) => void }) {
  if (m.role === 'user') {
    return <div className="ai-msg-user">{m.text}</div>;
  }
  // Assistant
  const { clean, ids } = A.extractCitations(m.text);
  return (
    <div className="ai-msg-asst">
      {m.context && m.context.length > 0 && m.text === '' && !m.pending && (
        <div className="ai-no-context">No relevant notes found. Try rephrasing.</div>
      )}
      {m.context && m.context.length > 0 && (
        <div className="ai-context-pills">
          <span className="ai-context-label">Context: </span>
          {m.context.slice(0, 3).map(c => (
            <button
              key={c.noteId}
              type="button"
              className="ai-context-pill"
              onClick={() => onOpenNote(c.noteId)}
              title={c.snippet}
            >{c.title}</button>
          ))}
          {m.context.length > 3 && (
            <span className="ai-context-more">+{m.context.length - 3} more</span>
          )}
        </div>
      )}
      <div className="ai-msg-body">
        {clean.split('\n').map((line, i) => <div key={i}>{line || ' '}</div>)}
        {m.pending && <span className="ai-cursor">▍</span>}
      </div>
      {ids.length > 0 && (
        <div className="ai-citations">
          {ids.map((id, i) => (
            <button
              key={id}
              type="button"
              className="ai-citation"
              onClick={() => onOpenNote(id)}
            >[{i + 1}] open source</button>
          ))}
        </div>
      )}
    </div>
  );
}

function StatusCard({ kind, title, children }: { kind: 'info' | 'warn' | 'error'; title: string; children: React.ReactNode }) {
  return (
    <div className={`ai-status ${kind}`}>
      <div className="ai-status-title">{title}</div>
      <div className="ai-status-body">{children}</div>
    </div>
  );
}
