#!/bin/bash
set -e

MODELS="${OLLAMA_MODELS:-deepseek-r1:7b}"

# Start Ollama server in background
ollama serve &
OLLAMA_PID=$!

echo "[zveltio-deepseek] Waiting for Ollama to be ready..."
until curl -sf http://localhost:11434/api/tags > /dev/null 2>&1; do
  sleep 1
done
echo "[zveltio-deepseek] Ollama is ready."

# Pull each model if not already present
IFS=',' read -ra MODEL_LIST <<< "$MODELS"
for model in "${MODEL_LIST[@]}"; do
  model="$(echo "$model" | tr -d '[:space:]')"
  if ollama list 2>/dev/null | grep -q "^${model}"; then
    echo "[zveltio-deepseek] Model '${model}' already present, skipping pull."
  else
    echo "[zveltio-deepseek] Pulling model '${model}'..."
    ollama pull "$model"
    echo "[zveltio-deepseek] Model '${model}' pulled successfully."
  fi
done

echo "[zveltio-deepseek] All models ready. Ollama listening on :11434"

# Keep the server running
wait $OLLAMA_PID
