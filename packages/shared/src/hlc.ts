// Hybrid logical clock — tiny implementation.
// Format: <13-digit ms timestamp>-<5-digit logical counter>
// Comparison is lexicographic (zero-padded fields).

export interface HlcState { ms: number; counter: number; }

export function hlcZero(): HlcState { return { ms: 0, counter: 0 }; }

export function hlcTick(prev: HlcState, nowMs: number = Date.now()): HlcState {
  if (nowMs > prev.ms) return { ms: nowMs, counter: 0 };
  return { ms: prev.ms, counter: prev.counter + 1 };
}

export function hlcEncode(s: HlcState): string {
  return `${String(s.ms).padStart(13, '0')}-${String(s.counter).padStart(5, '0')}`;
}

export function hlcDecode(str: string): HlcState {
  const [ms, counter] = str.split('-');
  return { ms: Number(ms), counter: Number(counter) };
}

export function hlcCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
