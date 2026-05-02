// Persistent AI prefs that survive app restarts. Currently a single
// boolean — whether to use the real bge-small embedder vs the no-op
// embedder (default off; BM25 carries retrieval until the user opts in
// and downloads the 33 MB ONNX model + 250 KB vocab).
//
// Kept out of session.ts because these prefs are device-local, not
// per-account: switching accounts shouldn't toggle the embedder.

import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY_USE_REAL_EMBEDDER = 'meo.ai.useRealEmbedder';

export async function getUseRealEmbedder(): Promise<boolean> {
  const v = await AsyncStorage.getItem(KEY_USE_REAL_EMBEDDER);
  return v === '1';
}

export async function setUseRealEmbedder(on: boolean): Promise<void> {
  await AsyncStorage.setItem(KEY_USE_REAL_EMBEDDER, on ? '1' : '0');
}
