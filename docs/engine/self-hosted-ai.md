# Self-Hosted AI

Zveltio ships two ready-made Docker images that let you run AI models entirely on your own hardware — no API keys, no data leaving your servers, no per-token costs.

---

## Overview

| Image | Best for | Default model | Min. RAM |
|---|---|---|---|
| **zveltio/ollama** | General LLMs (Llama, Mistral, Gemma, Phi…) | `llama3.2` | 8 GB |
| **zveltio/deepseek** | Reasoning & code (DeepSeek-R1 series) | `deepseek-r1:7b` | 8 GB |

Both images are built on top of the official [Ollama](https://ollama.com) runtime and expose the same HTTP API on port `11434`. The Zveltio Engine connects to them exactly like any other Ollama provider.

---

## Quick Start

### 1. Start the AI stack alongside Zveltio

```bash
# Both Ollama and DeepSeek
docker compose -f docker-compose.yml -f docker-compose.ai.yml up -d

# Only Ollama
docker compose -f docker-compose.yml -f docker-compose.ai.yml \
  --profile ai-ollama up -d

# Only DeepSeek
docker compose -f docker-compose.yml -f docker-compose.ai.yml \
  --profile ai-deepseek up -d
```

On first start the container pulls the default model automatically. This can take a few minutes depending on your internet connection (models range from 2 GB to 10+ GB).

### 2. Configure the provider in Studio

Open **Studio → AI → Add Provider**, select **Ollama**, and enter:

| Field | Ollama | DeepSeek |
|---|---|---|
| Base URL | `http://zveltio-ollama:11434` | `http://zveltio-deepseek:11434` |
| Default Model | `llama3.2` | `deepseek-r1:7b` |
| API Key | *(leave empty)* | *(leave empty)* |

Save and set as default — the engine will use it for all AI features (chat, schema generation, data quality, embeddings).

---

## Environment Variables

Add these to your `.env` file to customise the containers.

### Ollama

```dotenv
# Port exposed on the host (default 11434)
OLLAMA_PORT=11434

# Comma-separated list of models to pull on first start
OLLAMA_MODELS=llama3.2

# How many requests to process in parallel (default 2)
OLLAMA_NUM_PARALLEL=2

# Seconds to keep the model loaded in memory between requests
# Set to 0 to unload immediately (saves RAM, slower first request)
OLLAMA_KEEP_ALIVE=300
```

### DeepSeek

```dotenv
# Port exposed on the host (default 11435, avoids conflict with Ollama)
DEEPSEEK_PORT=11435

# Model variant — pick based on your hardware:
#   deepseek-r1:7b          ~4.7 GB  — 8 GB RAM, CPU-only OK
#   deepseek-r1:14b         ~9.0 GB  — 16 GB RAM or GPU recommended
#   deepseek-coder-v2:16b   ~9.1 GB  — GPU strongly recommended for code
DEEPSEEK_MODELS=deepseek-r1:7b

DEEPSEEK_NUM_PARALLEL=1
DEEPSEEK_KEEP_ALIVE=300
```

---

## GPU Acceleration

The compose overlay automatically requests all available NVIDIA GPUs via the Docker `deploy.resources.reservations` spec. No extra configuration needed — if a GPU is present Docker will use it; if not, the container falls back to CPU.

**NVIDIA requirements:**
- NVIDIA driver ≥ 525
- [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html) installed on the host

**AMD / Apple Silicon (macOS):**  
Ollama has native support for both. For AMD GPUs on Linux set `OLLAMA_GPU=rocm` in the container environment. For Apple Silicon use the native Ollama binary (macOS GPU offload is not available inside Docker on Apple Silicon).

---

## Choosing a Model

### For Ollama (general-purpose)

| Model | Size | Use case |
|---|---|---|
| `llama3.2` | 2.0 GB | Fast, great for structured tasks & schema generation |
| `llama3.1:8b` | 4.7 GB | Better reasoning, still CPU-friendly |
| `mistral` | 4.1 GB | Good at instruction-following and JSON output |
| `gemma2:9b` | 5.4 GB | Strong multilingual support |
| `phi3.5` | 2.2 GB | Very fast, good for simple prompts |

### For DeepSeek (reasoning & code)

| Model | Size | Use case |
|---|---|---|
| `deepseek-r1:7b` | 4.7 GB | Default — reasoning, data quality, NL validation |
| `deepseek-r1:14b` | 9.0 GB | Better accuracy, needs more RAM |
| `deepseek-coder-v2:16b` | 9.1 GB | Best for code generation, edge functions |

To pull additional models at runtime:

```bash
docker exec zveltio-ollama ollama pull mistral
docker exec zveltio-deepseek ollama pull deepseek-r1:14b
```

---

## Data Privacy

When using these self-hosted images:

- All inference runs **locally on your hardware**
- No prompts, no data, and no model responses are sent to external servers
- Models are stored in named Docker volumes (`ollama_models`, `deepseek_models`) on your host

This makes them the recommended choice for organisations processing sensitive or regulated data (GDPR, NIS2, healthcare, finance, government).

---

## Troubleshooting

**Container exits immediately after starting**  
Check logs: `docker logs zveltio-ollama`. Usually caused by insufficient disk space for the model download.

**Model pull is slow**  
Model files are large. `deepseek-r1:7b` is ~4.7 GB; expect several minutes on a typical connection. Pull progress is shown in `docker logs -f zveltio-ollama`.

**"connection refused" from the engine**  
The engine starts before the AI containers finish pulling models. The `start_period` in the healthcheck gives 2–3 minutes. If the engine is already running, adding the provider in Studio is enough — it will connect at request time.

**Out of memory errors during inference**  
Switch to a smaller model or reduce `OLLAMA_NUM_PARALLEL` to `1`. Unload idle models faster with `OLLAMA_KEEP_ALIVE=60`.

**GPU not detected**  
Verify NVIDIA Container Toolkit: `docker run --rm --gpus all nvidia/cuda:12.0-base nvidia-smi`. If this fails, reinstall the toolkit.
