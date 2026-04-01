#!/bin/bash
set -e

MODELS="${OLLAMA_MODELS:-llama3.2}"

# Start Ollama server in background
ollama serve &
OLLAMA_PID=$!

echo "[zveltio-ollama] Waiting for Ollama to be ready..."
until curl -sf http://localhost:11434/api/tags > /dev/null 2>&1; do
  sleep 1
done
echo "[zveltio-ollama] Ollama is ready."

# Pull each model if not already present
IFS=',' read -ra MODEL_LIST <<< "$MODELS"
for model in "${MODEL_LIST[@]}"; do
  model="$(echo "$model" | tr -d '[:space:]')"
  if ollama list 2>/dev/null | grep -q "^${model}"; then
    echo "[zveltio-ollama] Model '${model}' already present, skipping pull."
  else
    echo "[zveltio-ollama] Pulling model '${model}'..."
    ollama pull "$model"
    echo "[zveltio-ollama] Model '${model}' pulled successfully."
  fi
done

echo "[zveltio-ollama] All models ready. Ollama listening on :11434"

# Keep the server running
wait $OLLAMA_PID
