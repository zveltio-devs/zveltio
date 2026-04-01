FROM ollama/ollama:latest

# Copy startup script
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Models are stored in a volume at /root/.ollama
# Default model pulled at first start: llama3.2
# Override via OLLAMA_MODELS env var (comma-separated, e.g. "llama3.2,mistral")

EXPOSE 11434

ENTRYPOINT ["/entrypoint.sh"]
