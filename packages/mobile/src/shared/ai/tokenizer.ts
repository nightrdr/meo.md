// BERT-style WordPiece tokenizer (uncased). Same algorithm BERT, BGE,
// and MiniLM all use. Pure JS, no native deps.
//
// Usage:
//   const tok = await BertTokenizer.fromVocabText(vocabTxt);
//   const enc = tok.encode('hello world', { maxLength: 512 });
//   // enc.input_ids, enc.attention_mask, enc.token_type_ids
//
// The vocab file is the standard BERT `vocab.txt` (one token per line,
// 0-indexed). bge-small-en-v1.5 ships an identical vocab to bert-base-uncased
// (30,522 tokens).

const CLS_TOKEN = '[CLS]';
const SEP_TOKEN = '[SEP]';
const PAD_TOKEN = '[PAD]';
const UNK_TOKEN = '[UNK]';

export interface TokenizerEncoding {
  input_ids: Int32Array;
  attention_mask: Int32Array;
  token_type_ids: Int32Array;
}

export interface EncodeOptions {
  /** Max sequence length (model dependent). Default 512 for bge-small. */
  maxLength?: number;
  /** Pad to maxLength (default true - many runtimes require fixed shapes). */
  pad?: boolean;
}

export class BertTokenizer {
  readonly vocab: Map<string, number>;
  readonly clsId: number;
  readonly sepId: number;
  readonly padId: number;
  readonly unkId: number;
  readonly maxInputCharsPerWord = 100;

  private constructor(vocab: Map<string, number>) {
    this.vocab = vocab;
    this.clsId = mustGet(vocab, CLS_TOKEN);
    this.sepId = mustGet(vocab, SEP_TOKEN);
    this.padId = mustGet(vocab, PAD_TOKEN);
    this.unkId = mustGet(vocab, UNK_TOKEN);
  }

  /** Build from a raw vocab.txt - one token per line, 0-indexed. */
  static fromVocabText(text: string): BertTokenizer {
    const vocab = new Map<string, number>();
    let i = 0;
    for (const line of text.split('\n')) {
      const tok = line.trim();
      if (tok.length === 0) continue;
      vocab.set(tok, i++);
    }
    return new BertTokenizer(vocab);
  }

  encode(text: string, opts: EncodeOptions = {}): TokenizerEncoding {
    const maxLength = opts.maxLength ?? 512;
    const pad = opts.pad ?? true;

    const tokens: string[] = [];
    for (const w of basicTokenize(text)) {
      tokens.push(...this.wordpieceTokenize(w));
    }

    // Truncate so [CLS] + tokens + [SEP] fits
    const maxBody = maxLength - 2;
    const body = tokens.length > maxBody ? tokens.slice(0, maxBody) : tokens;
    const ids: number[] = [this.clsId];
    for (const t of body) ids.push(this.vocab.get(t) ?? this.unkId);
    ids.push(this.sepId);

    const len = pad ? maxLength : ids.length;
    const input_ids = new Int32Array(len);
    const attention_mask = new Int32Array(len);
    const token_type_ids = new Int32Array(len);
    for (let i = 0; i < ids.length; i++) {
      input_ids[i] = ids[i];
      attention_mask[i] = 1;
      token_type_ids[i] = 0;
    }
    if (pad) {
      for (let i = ids.length; i < len; i++) {
        input_ids[i] = this.padId;
        // attention_mask + token_type_ids already zero
      }
    }
    return { input_ids, attention_mask, token_type_ids };
  }

  /**
   * Greedy longest-match WordPiece. For each "word" produced by basic-
   * tokenize, walk left-to-right and consume the longest prefix that's
   * in vocab; suffix pieces get a "##" prefix.
   */
  private wordpieceTokenize(word: string): string[] {
    if (word.length === 0) return [];
    if (word.length > this.maxInputCharsPerWord) return [UNK_TOKEN];

    const out: string[] = [];
    let start = 0;
    while (start < word.length) {
      let end = word.length;
      let cur: string | null = null;
      while (start < end) {
        let piece = word.slice(start, end);
        if (start > 0) piece = '##' + piece;
        if (this.vocab.has(piece)) { cur = piece; break; }
        end--;
      }
      if (cur === null) {
        return [UNK_TOKEN];
      }
      out.push(cur);
      start = end;
    }
    return out;
  }
}

function mustGet(vocab: Map<string, number>, key: string): number {
  const v = vocab.get(key);
  if (v === undefined) throw new Error(`vocab missing required token: ${key}`);
  return v;
}

// ----------------------------------------------------------------------------
// Basic tokenizer - lowercases, strips control chars, splits on whitespace +
// punctuation, normalizes Unicode (NFKC).
// ----------------------------------------------------------------------------

function basicTokenize(text: string): string[] {
  // Normalize, lowercase, strip control characters and accents.
  const normalized = text.normalize('NFKC').toLowerCase();

  const out: string[] = [];
  let buf = '';
  const flush = () => {
    if (buf.length > 0) { out.push(buf); buf = ''; }
  };

  for (const ch of normalized) {
    const code = ch.charCodeAt(0);
    if (isControl(code)) {
      flush();
      continue;
    }
    if (isWhitespace(ch)) {
      flush();
      continue;
    }
    if (isPunctuation(ch)) {
      flush();
      out.push(ch);
      continue;
    }
    // Chinese characters (and other CJK) are emitted as single-char tokens
    // per the BERT basic tokenizer.
    if (isCjk(code)) {
      flush();
      out.push(ch);
      continue;
    }
    buf += ch;
  }
  flush();
  return out;
}

function isControl(c: number): boolean {
  if (c === 0x09 || c === 0x0a || c === 0x0d) return false; // tab, lf, cr are whitespace
  return (c >= 0 && c < 0x20) || (c >= 0x7f && c < 0xa0);
}

function isWhitespace(ch: string): boolean {
  if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') return true;
  return /\s/.test(ch);
}

function isPunctuation(ch: string): boolean {
  const c = ch.charCodeAt(0);
  // ASCII punctuation
  if ((c >= 33 && c <= 47) || (c >= 58 && c <= 64) ||
      (c >= 91 && c <= 96) || (c >= 123 && c <= 126)) return true;
  // Unicode punctuation
  return /[\p{P}\p{S}]/u.test(ch);
}

function isCjk(c: number): boolean {
  return (
    (c >= 0x4E00 && c <= 0x9FFF) ||
    (c >= 0x3400 && c <= 0x4DBF) ||
    (c >= 0x20000 && c <= 0x2A6DF) ||
    (c >= 0x2A700 && c <= 0x2B73F) ||
    (c >= 0x2B740 && c <= 0x2B81F) ||
    (c >= 0x2B820 && c <= 0x2CEAF) ||
    (c >= 0xF900 && c <= 0xFAFF) ||
    (c >= 0x2F800 && c <= 0x2FA1F)
  );
}
