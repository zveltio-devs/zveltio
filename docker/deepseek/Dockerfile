FROM ollama/ollama:latest

# Copy startup script
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Default model: deepseek-r1:7b (7B params, ~4.7GB — runs on CPU+RAM)
# For better quality use deepseek-r1:14b (needs ~10GB RAM)
# For code tasks use deepseek-coder-v2:16b
# Override via OLLAMA_MODELS env var (comma-separated)

EXPOSE 11434

ENTRYPOINT ["/entrypoint.sh"]
