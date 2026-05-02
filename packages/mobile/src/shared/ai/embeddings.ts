// Mobile embedder. Two implementations behind the same `Embedder` interface:
//
//   1. NoopEmbedder — returns zero-vectors. The default; lets hybrid
//      retrieval gracefully degrade to BM25-only without throwing.
//
//   2. OnnxBgeSmallEmbedder — bge-small-en-v1.5 via onnxruntime-react-native.
//      Loads the WordPiece tokenizer + ONNX model on first call. Mean-pools
//      the last_hidden_state weighted by attention_mask, then L2-normalizes.
//      Output is a 384-dim Float32Array, ready to drop into the same vector
//      store + cosine path the desktop embedder uses.
//
// The ONNX model + vocab download on first use because they're 33 MB and
// 250 KB respectively — bundling both inflates the IPA past App Store size
// warnings. Resumable via `expo-file-system`'s `createDownloadResumable`.

import * as FileSystem from 'expo-file-system';
import { BertTokenizer, type TokenizerEncoding } from './tokenizer';
import type { Embedder } from './types';

const DIM = 384;
export const EMBEDDER_FILES_DIR = `${FileSystem.documentDirectory}embedder/`;
const ONNX_FILENAME = 'bge-small-en-v1.5-quantized.onnx';
const VOCAB_FILENAME = 'vocab.txt';

// Hugging Face Hub. Both URLs are public; resumable via Range headers.
export const ONNX_URL = 'https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/main/onnx/model_quantized.onnx';
export const VOCAB_URL = 'https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/main/vocab.txt';

// ----------------------------------------------------------------------------
// NoopEmbedder — default
// ----------------------------------------------------------------------------

export class NoopEmbedder implements Embedder {
  readonly id = 'noop';
  readonly dim = DIM;
  async embed(_text: string): Promise<Float32Array> {
    return new Float32Array(DIM);
  }
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return texts.map(() => new Float32Array(DIM));
  }
}

// ----------------------------------------------------------------------------
// File management — downloads with progress
// ----------------------------------------------------------------------------

export interface FileStatus {
  installed: boolean;
  bytes?: number;
}

export async function getEmbedderFileStatus(): Promise<{
  onnx: FileStatus;
  vocab: FileStatus;
  ready: boolean;
}> {
  await FileSystem.makeDirectoryAsync(EMBEDDER_FILES_DIR, { intermediates: true }).catch(() => {});
  const onnxPath = EMBEDDER_FILES_DIR + ONNX_FILENAME;
  const vocabPath = EMBEDDER_FILES_DIR + VOCAB_FILENAME;
  const [onnxInfo, vocabInfo] = await Promise.all([
    FileSystem.getInfoAsync(onnxPath, { size: true }),
    FileSystem.getInfoAsync(vocabPath, { size: true }),
  ]);
  return {
    onnx: { installed: onnxInfo.exists, bytes: (onnxInfo as any).size },
    vocab: { installed: vocabInfo.exists, bytes: (vocabInfo as any).size },
    ready: onnxInfo.exists && vocabInfo.exists,
  };
}

export interface DownloadProgress {
  totalBytes: number;
  bytesWritten: number;
  filename: string;
}

export async function downloadEmbedderFiles(
  onProgress?: (p: DownloadProgress) => void,
): Promise<void> {
  await FileSystem.makeDirectoryAsync(EMBEDDER_FILES_DIR, { intermediates: true }).catch(() => {});
  const onnxPath = EMBEDDER_FILES_DIR + ONNX_FILENAME;
  const vocabPath = EMBEDDER_FILES_DIR + VOCAB_FILENAME;

  const dl = (url: string, dest: string, filename: string) => new Promise<void>((resolve, reject) => {
    const task = FileSystem.createDownloadResumable(
      url,
      dest,
      {},
      (p) => onProgress?.({
        totalBytes: p.totalBytesExpectedToWrite,
        bytesWritten: p.totalBytesWritten,
        filename,
      }),
    );
    task.downloadAsync()
      .then((res) => res ? resolve() : reject(new Error(`download cancelled: ${filename}`)))
      .catch(reject);
  });

  // Vocab first (small, fails fast on network errors)
  await dl(VOCAB_URL, vocabPath, VOCAB_FILENAME);
  await dl(ONNX_URL, onnxPath, ONNX_FILENAME);
}

export async function deleteEmbedderFiles(): Promise<void> {
  await FileSystem.deleteAsync(EMBEDDER_FILES_DIR, { idempotent: true });
}

// ----------------------------------------------------------------------------
// OnnxBgeSmallEmbedder
// ----------------------------------------------------------------------------

export class OnnxBgeSmallEmbedder implements Embedder {
  readonly id = 'bge-small-en-v1.5';
  readonly dim = DIM;
  private session: any | null = null;
  private tokenizer: BertTokenizer | null = null;
  private maxLength = 512;

  /** Load the ONNX session + tokenizer. Idempotent. */
  async load(): Promise<void> {
    if (this.session && this.tokenizer) return;
    const status = await getEmbedderFileStatus();
    if (!status.ready) {
      throw new Error('Embedder files missing. Call downloadEmbedderFiles() first.');
    }
    const vocabPath = EMBEDDER_FILES_DIR + VOCAB_FILENAME;
    const onnxPath = EMBEDDER_FILES_DIR + ONNX_FILENAME;
    const vocabText = await FileSystem.readAsStringAsync(vocabPath);
    this.tokenizer = BertTokenizer.fromVocabText(vocabText);

    // Lazy require — onnxruntime-react-native pulls in a substantial native
    // pod; only load when the user actually opts into real embeddings.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ort = require('onnxruntime-react-native');
    this.session = await ort.InferenceSession.create(onnxPath);
  }

  async embed(text: string): Promise<Float32Array> {
    if (!this.session || !this.tokenizer) await this.load();
    const enc = this.tokenizer!.encode(text, { maxLength: this.maxLength, pad: true });
    return await this.runOnce(enc);
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (const t of texts) out.push(await this.embed(t));
    return out;
  }

  private async runOnce(enc: TokenizerEncoding): Promise<Float32Array> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ort = require('onnxruntime-react-native');
    const len = enc.input_ids.length;
    const dims = [1, len];
    // ONNX expects int64 for the BERT-family inputs.
    const toBig = (a: Int32Array) => {
      const big = new BigInt64Array(a.length);
      for (let i = 0; i < a.length; i++) big[i] = BigInt(a[i]);
      return big;
    };
    const feeds: Record<string, any> = {
      input_ids: new ort.Tensor('int64', toBig(enc.input_ids), dims),
      attention_mask: new ort.Tensor('int64', toBig(enc.attention_mask), dims),
      token_type_ids: new ort.Tensor('int64', toBig(enc.token_type_ids), dims),
    };
    const out = await this.session!.run(feeds);
    // The ONNX export names the embedding output 'last_hidden_state' on
    // most builds; Xenova's quantized ones sometimes use 'sentence_embedding'.
    // Fall back to the first available output.
    const tensor = out.last_hidden_state ?? out.sentence_embedding
                 ?? out[Object.keys(out)[0]];
    const flat = tensor.data as Float32Array;
    const seqLen = tensor.dims[1];
    const dim = tensor.dims[2];

    // Mean pool, weighted by attention_mask, then L2 normalize.
    const sum = new Float32Array(dim);
    let weight = 0;
    for (let i = 0; i < seqLen; i++) {
      if (enc.attention_mask[i] === 0) continue;
      const off = i * dim;
      for (let k = 0; k < dim; k++) sum[k] += flat[off + k];
      weight++;
    }
    if (weight > 0) {
      for (let k = 0; k < dim; k++) sum[k] /= weight;
    }
    let norm = 0;
    for (let k = 0; k < dim; k++) norm += sum[k] * sum[k];
    norm = Math.sqrt(norm) || 1;
    for (let k = 0; k < dim; k++) sum[k] /= norm;
    return sum;
  }

  async dispose(): Promise<void> {
    if (this.session && this.session.release) {
      await this.session.release();
    }
    this.session = null;
    this.tokenizer = null;
  }
}

// ----------------------------------------------------------------------------
// Factory
// ----------------------------------------------------------------------------

let cachedReal: OnnxBgeSmallEmbedder | null = null;

export async function getEmbedder(useReal = false): Promise<Embedder> {
  if (!useReal) return new NoopEmbedder();
  if (cachedReal) return cachedReal;
  cachedReal = new OnnxBgeSmallEmbedder();
  await cachedReal.load();
  return cachedReal;
}

export function clearEmbedderCache(): void {
  if (cachedReal) {
    cachedReal.dispose().catch(() => {});
    cachedReal = null;
  }
}
