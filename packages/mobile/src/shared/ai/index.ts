export * from './types';
export * from './registry';
export * from './embeddings';
export * from './bm25';
export * from './vectorStore';
export { SqliteVectorStore } from './vectorStore.sqlite';
export * from './retrieval';
export * from './rag';
export * from './vec-math';
export { OllamaBackend } from './backends/ollama';
export {
  LlamaRnBackend,
  MODEL_FILES,
  MODELS_DIR,
  modelPath,
  ensureModelsDir,
  isModelInstalled,
  downloadModel,
  deleteModel,
} from './backends/llamaRn';
export {
  FoundationBackend,
  isFoundationModelsCapable,
  isFoundationModelsAvailable,
} from './backends/foundation';
