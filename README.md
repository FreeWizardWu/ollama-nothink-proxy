# Ollama No-Think Proxy

A lightweight local proxy that automatically disables thinking mode (`think: false`) for specified Ollama models, with OpenAI-compatible API support.

Works with all Ollama model formats (GGUF, MLX, etc.) on macOS, Linux, and Windows.

## Why

Modern reasoning models like Qwen 3.5/3.6 have a built-in thinking mode that produces chain-of-thought before answering. This is great for complex tasks, but unnecessary and wasteful for simple ones like translation, quick Q&A, or text formatting.

The problem: many tools and plugins (e.g. Immersive Translate, Raycast extensions, editor plugins) call Ollama's API but don't expose a way to disable thinking. You end up waiting for the model to "think" through a one-sentence translation.

This proxy sits between your tools and Ollama, automatically injecting `think: false` for models you specify — no changes needed on the client side. Just point your tool at the proxy port instead of Ollama directly.

## Features

- **No-thinking mode** — Aliased models always respond without chain-of-thought
- **OpenAI-compatible API** — Drop-in replacement for OpenAI clients
- **Dual API support** — Both Ollama native and OpenAI `/v1` endpoints
- **Streaming** — Full SSE streaming support
- **macOS service** — launchd integration with auto-restart and boot-time startup
- **Global CLI** — One-command management from any directory (macOS)
- **Configurable logging** — Off by default, enable for debugging

## Install

```bash
git clone https://github.com/FreeWizardWu/ollama-nothink-proxy.git
cd ollama-nothink-proxy
npm install
```

### macOS

```bash
# Enable global command (optional)
sudo ln -sf "$(pwd)/bin/ollama-nothink" /usr/local/bin/ollama-nothink
```

### Other platforms

```bash
# Start the proxy directly
npm run build && npm start
```

## Usage (macOS)

```bash
ollama-nothink up       # Start service (launchd, auto-restart, boot-time startup)
ollama-nothink down     # Stop service
ollama-nothink restart  # Restart (rebuild + reload config)
ollama-nothink status   # Show status and health check
ollama-nothink logs     # Tail logs
```

## Endpoints

| Endpoint | Description |
|----------|-------------|
| `http://127.0.0.1:11435` | Ollama native API proxy |
| `http://127.0.0.1:11435/v1` | OpenAI-compatible API |

## Configuration

Edit `proxy.config.json`:

```json
{
  "upstreamBaseUrl": "http://127.0.0.1:11434",
  "listenHost": "127.0.0.1",
  "listenPort": 11435,
  "logLevel": "off",
  "aliases": {
    "my-alias": {
      "target": "model-name-in-ollama",
      "disableThinking": true
    }
  }
}
```

### Logging

- `"logLevel": "off"` — No request logs (default)
- `"logLevel": "debug"` — Detailed request/response logs

Run `ollama-nothink restart` after config changes.

### API Key

Set the `PROXY_API_KEY` environment variable to require authentication on `/v1/*` endpoints.

## Example

```bash
curl http://127.0.0.1:11435/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "qwen36-nvfp4-nothink",
    "stream": false,
    "messages": [
      {
        "role": "user",
        "content": "Explain quantum computing in one sentence."
      }
    ]
  }'
```

## How It Works

```
Client → Proxy (127.0.0.1:11435) → Ollama (127.0.0.1:11434)
             │
             ├─ Resolve model alias → inject think:false
             ├─ Convert OpenAI format ↔ Ollama format
             └─ Forward request and translate response
```

## Tech Stack

- [Hono](https://hono.dev/) — Lightweight HTTP framework
- TypeScript + Node.js
- macOS launchd for service management

## License

[MIT](LICENSE)
