// Smoke-test the WordPiece tokenizer. Uses a tiny synthetic vocab so the
// test is self-contained - no 250 KB vocab.txt download required to run.
//
// Validates: required special tokens, basic-tokenize splitting, greedy
// longest-prefix wordpiece matching, padding + truncation, [UNK] fallback
// for OOV words.

import { strict as assert } from 'node:assert';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

execSync(
  `npx tsc --module ES2022 --target ES2022 --moduleResolution node --esModuleInterop --skipLibCheck --outDir test-dist src/shared/ai/tokenizer.ts`,
  { cwd: __dirname, stdio: 'inherit' },
);

const { BertTokenizer } = await import('./test-dist/tokenizer.js');

// Synthetic vocab - ids assigned in line order
const vocab = [
  '[PAD]',          // 0
  '[UNK]',          // 1
  '[CLS]',          // 2
  '[SEP]',          // 3
  'hello',          // 4
  'world',          // 5
  '##s',            // 6   suffix
  '##ing',          // 7
  'pl',             // 8
  '##ay',           // 9
  '!',              // 10
  ',',              // 11
  '.',              // 12
  '中',             // 13
  '国',             // 14
  'embed',          // 15
  '##ding',         // 16
];
const tok = BertTokenizer.fromVocabText(vocab.join('\n'));

// 1. Required tokens resolved
assert.equal(tok.clsId, 2);
assert.equal(tok.sepId, 3);
assert.equal(tok.padId, 0);
assert.equal(tok.unkId, 1);
console.log('OK: special tokens resolved');

// 2. Basic happy path: hello world
{
  const enc = tok.encode('hello world', { maxLength: 6, pad: true });
  // [CLS] hello world [SEP] [PAD] [PAD]
  assert.deepEqual(Array.from(enc.input_ids), [2, 4, 5, 3, 0, 0]);
  assert.deepEqual(Array.from(enc.attention_mask), [1, 1, 1, 1, 0, 0]);
  console.log('OK: hello world →', Array.from(enc.input_ids));
}

// 3. Wordpiece: "playing" → ["pl", "##ay", "##ing"]
{
  const enc = tok.encode('playing', { maxLength: 8, pad: false });
  assert.deepEqual(Array.from(enc.input_ids), [2, 8, 9, 7, 3]);
  console.log('OK: playing → pl ##ay ##ing');
}

// 4. OOV word → [UNK]
{
  const enc = tok.encode('xyzabc', { maxLength: 5, pad: false });
  assert.deepEqual(Array.from(enc.input_ids), [2, 1, 3]);
  console.log('OK: OOV → [UNK]');
}

// 5. Punctuation split off as its own token
{
  const enc = tok.encode('hello, world!', { maxLength: 8, pad: false });
  // [CLS] hello , world ! [SEP]
  assert.deepEqual(Array.from(enc.input_ids), [2, 4, 11, 5, 10, 3]);
  console.log('OK: punctuation split');
}

// 6. CJK chars → one token each
{
  const enc = tok.encode('中国', { maxLength: 6, pad: false });
  assert.deepEqual(Array.from(enc.input_ids), [2, 13, 14, 3]);
  console.log('OK: CJK chars split into single-char tokens');
}

// 7. Truncation: > maxLength
{
  const enc = tok.encode('hello world hello world hello world', { maxLength: 5, pad: true });
  // maxLength=5, so we keep [CLS] + 3 body tokens + [SEP]
  assert.equal(enc.input_ids.length, 5);
  assert.equal(enc.input_ids[0], 2);
  assert.equal(enc.input_ids[4], 3);
  console.log('OK: truncation preserves CLS/SEP at boundaries');
}

// 8. Lowercasing
{
  const enc = tok.encode('HELLO World', { maxLength: 4, pad: false });
  assert.deepEqual(Array.from(enc.input_ids), [2, 4, 5, 3]);
  console.log('OK: lowercased');
}

// 9. Combined wordpiece + suffix
{
  const enc = tok.encode('embedding', { maxLength: 6, pad: false });
  // embed ##ding
  assert.deepEqual(Array.from(enc.input_ids), [2, 15, 16, 3]);
  console.log('OK: embedding → embed ##ding');
}

console.log('\nAll tokenizer tests passed.');
