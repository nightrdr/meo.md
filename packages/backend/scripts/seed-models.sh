#!/usr/bin/env bash
# Populate MEO_MODEL_DIR with the GGUF / ONNX files referenced by
# internal/models/manifest.json. Run from packages/backend/.
#
# Why a script and not the upload endpoint:
#   The /models/:id/upload endpoint is admin-token-gated and meant for
#   production "push to staging" workflows. For local dev / a fresh
#   self-hosted install, just dropping the file at <model_dir>/<id>.bin
#   is faster and doesn't require restarting the server with
#   MEO_ADMIN_TOKEN set.
#
# Usage:
#   ./scripts/seed-models.sh           # download everything in manifest
#   ./scripts/seed-models.sh small     # only the embedder (33 MB)
#   ./scripts/seed-models.sh qwen      # only the Qwen variants
#
# The "small" preset is 33 MB and finishes in ~5 seconds on a typical
# residential connection. The full set is ~13 GB and takes a while.

set -euo pipefail

MODEL_DIR="${MEO_MODEL_DIR:-$(pwd)/models}"
mkdir -p "$MODEL_DIR"

# Each row: <id> <huggingface_url>
# We pull from Xenova / unsloth / bartowski mirrors that publish public
# Q4_K_M GGUFs under their own LFS quotas. Substitute when models move.
declare -a entries=(
  "bge-small-en-v1.5|https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/main/onnx/model_quantized.onnx|small"
  "qwen2.5-1.5b-q4|https://huggingface.co/bartowski/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/Qwen2.5-1.5B-Instruct-Q4_K_M.gguf|qwen"
  "qwen2.5-7b-q4|https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/main/Qwen2.5-7B-Instruct-Q4_K_M.gguf|qwen"
  "llama3.1-8b-q4|https://huggingface.co/bartowski/Meta-Llama-3.1-8B-Instruct-GGUF/resolve/main/Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf|llama"
  "phi3.5-mini-q4|https://huggingface.co/bartowski/Phi-3.5-mini-instruct-GGUF/resolve/main/Phi-3.5-mini-instruct-Q4_K_M.gguf|phi"
)

filter="${1:-}"

for entry in "${entries[@]}"; do
  IFS='|' read -r id url tag <<< "$entry"
  if [ -n "$filter" ] && [ "$filter" != "$tag" ] && [ "$filter" != "$id" ]; then
    continue
  fi
  out="$MODEL_DIR/$id.bin"
  if [ -s "$out" ]; then
    echo "[skip] $id already present ($(du -h "$out" | cut -f1))"
    continue
  fi
  echo "[get]  $id  ←  $url"
  # -L follows redirects; -C - resumes a partial download; --fail
  # exits non-zero on 4xx/5xx so a bad URL stops the script loud.
  curl -L --fail -C - -o "$out" "$url"
  echo "       wrote $(du -h "$out" | cut -f1)"
done

echo
echo "Done. Files in $MODEL_DIR:"
ls -lh "$MODEL_DIR"
