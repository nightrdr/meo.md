// Native dictation via the WebSpeech API (Agent 6 - deliverable §1).
//
// We deliberately use `window.SpeechRecognition` / `window.webkitSpeechRecognition`
// rather than a third-party / cloud STT provider:
//   - macOS: delegates to the OS Speech Recognition framework
//   - Windows 10+: delegates to the SAPI / built-in dictation engine
//   - iOS / Android (Safari / Chrome): on-device speech engine
//   - Linux: depends on the desktop environment - many distros lack a
//     SpeechRecognition implementation. We probe at module load and the
//     editor hides the mic button when unavailable, so users never see a
//     dead control.
//
// No API keys, no network calls, no third-party dependency.

// ────────────────────────────────────────────────────────────────────
// WebSpeech typings - the DOM lib doesn't ship them yet on every TS
// version, and Chromium / Safari only expose the constructor under the
// vendor-prefixed name. We declare the minimum surface we use.
// ────────────────────────────────────────────────────────────────────

interface SpeechRecognitionAlternativeMin {
  readonly transcript: string;
  readonly confidence: number;
}
interface SpeechRecognitionResultMin {
  readonly isFinal: boolean;
  readonly length: number;
  item(index: number): SpeechRecognitionAlternativeMin;
  [index: number]: SpeechRecognitionAlternativeMin;
}
interface SpeechRecognitionResultListMin {
  readonly length: number;
  item(index: number): SpeechRecognitionResultMin;
  [index: number]: SpeechRecognitionResultMin;
}
interface SpeechRecognitionEventMin extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultListMin;
}
interface SpeechRecognitionErrorEventMin extends Event {
  readonly error: string;
  readonly message?: string;
}
interface SpeechRecognitionMin extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((ev: SpeechRecognitionEventMin) => void) | null;
  onerror: ((ev: SpeechRecognitionErrorEventMin) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}
interface SpeechRecognitionCtorMin {
  new (): SpeechRecognitionMin;
}

function getCtor(): SpeechRecognitionCtorMin | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtorMin;
    webkitSpeechRecognition?: SpeechRecognitionCtorMin;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Returns true if WebSpeech is usable in the current browser. */
export function isDictationAvailable(): boolean {
  return getCtor() !== null;
}

export interface DictationOptions {
  /** Locale tag, e.g. 'en-US'. Defaults to navigator.language. */
  lang?: string;
  /** Fires for every interim (non-final) chunk. Editor uses this for the live caret-side preview. */
  onPartial: (text: string) => void;
  /** Fires once a chunk is committed by the engine (`isFinal === true`). The full final transcript for that chunk. */
  onFinal: (text: string) => void;
  /** Fires on any error or natural stop. */
  onEnd?: (reason: 'user' | 'error' | 'silence') => void;
  /** Auto-stop after this many ms of silence (no result events). Default 3s. */
  silenceMs?: number;
}

export interface DictationSession {
  /** Stop cleanly (commits any pending partial as final via the engine). */
  stop(): void;
  /** True until stop() returns or the engine ends. */
  readonly active: boolean;
}

/**
 * Start a dictation session. Caller MUST check isDictationAvailable() first;
 * this throws if the constructor is missing.
 *
 * The session yields:
 *   - onPartial("…")  for each interim chunk (replace the previous partial)
 *   - onFinal("…")    when the engine commits a chunk; partial should be cleared
 *   - onEnd(reason)   exactly once when the session ends
 *
 * The stream is restarted internally if the engine times out before the
 * caller asks to stop, since some browsers cap a single session at ~60s.
 */
export function startDictation(opts: DictationOptions): DictationSession {
  const Ctor = getCtor();
  if (!Ctor) throw new Error('SpeechRecognition is not available in this browser');

  let active = true;
  let userStopped = false;
  let silenceTimer: ReturnType<typeof setTimeout> | null = null;
  const silenceMs = opts.silenceMs ?? 3000;
  const lang = opts.lang ?? (typeof navigator !== 'undefined' ? navigator.language : 'en-US');

  const arm = (rec: SpeechRecognitionMin) => {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      // No speech for `silenceMs` - stop cleanly. The browser already
      // surfaces 'no-speech' in many cases, but we own the timer so the
      // UX is consistent across engines.
      userStopped = true;
      try { rec.stop(); } catch { /* already stopped */ }
    }, silenceMs);
  };

  let rec: SpeechRecognitionMin | null = null;
  const startNewSegment = () => {
    if (!active) return;
    const r = new Ctor();
    r.continuous = true;
    r.interimResults = true;
    r.lang = lang;
    r.maxAlternatives = 1;
    r.onstart = () => arm(r);
    r.onresult = (ev) => {
      arm(r);
      // Engines deliver `results[i]` with isFinal alternating between
      // false (interim) and true (committed). We collapse the interim
      // tail into a single onPartial string and forward each newly
      // committed chunk as onFinal.
      let interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const result = ev.results[i];
        const transcript = result[0]?.transcript ?? '';
        if (result.isFinal) {
          opts.onFinal(transcript);
        } else {
          interim += transcript;
        }
      }
      if (interim) opts.onPartial(interim);
      else opts.onPartial('');
    };
    r.onerror = (ev) => {
      // 'no-speech' / 'aborted' are normal endings. Anything else we
      // surface to the caller as an error reason.
      if (ev.error === 'no-speech' || ev.error === 'aborted') return;
      console.warn('dictation error', ev.error, ev.message);
      userStopped = true;
      active = false;
      try { r.abort(); } catch { /* noop */ }
      opts.onEnd?.('error');
    };
    r.onend = () => {
      if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
      if (userStopped || !active) {
        active = false;
        opts.onEnd?.(userStopped ? 'user' : 'silence');
        return;
      }
      // Browser auto-ended (e.g. Chrome's 60s cap). Restart so the user
      // can keep dictating without a click.
      try { startNewSegment(); }
      catch (e) {
        console.warn('dictation restart failed', e);
        active = false;
        opts.onEnd?.('error');
      }
    };
    rec = r;
    try { r.start(); }
    catch (e) {
      // Some browsers throw if start() is called too soon after stop();
      // try once more on the next macrotask.
      setTimeout(() => { try { r.start(); } catch { /* give up */ } }, 50);
    }
  };

  startNewSegment();

  return {
    get active() { return active; },
    stop() {
      if (!active) return;
      userStopped = true;
      active = false;
      if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
      try { rec?.stop(); } catch { /* noop */ }
    },
  };
}
