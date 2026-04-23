# Ollama No-Think Proxy

Ollama 本地代理，自动将指定模型的思考模式关闭（`think: false`），同时提供 OpenAI 兼容 API。

## 安装

```bash
# 全局命令（任意目录可用）
sudo ln -sf "$(pwd)/bin/ollama-nothink" /usr/local/bin/ollama-nothink
```

## 命令

```bash
ollama-nothink up       # 启动（launchd 后台常驻，开机自启）
ollama-nothink down     # 停止
ollama-nothink restart  # 重启（编译 + 重新加载配置）
ollama-nothink status   # 查看运行状态和健康检查
ollama-nothink logs     # 查看实时日志
```

## 端点

- Ollama 原生 API：`http://127.0.0.1:11435`
- OpenAI 兼容 API：`http://127.0.0.1:11435/v1`

## 已配置的模型别名

| 别名 | 实际模型 | 说明 |
|------|---------|------|
| `qwen36-nothink` | `qwen3.6:35b-a3b-q4_K_M` | GGUF 量化 |
| `qwen36-nvfp4-nothink` | `qwen3.6:35b-a3b-nvfp4` | NVFP4 量化（MLX 加速） |
| `gemma4-nothink` | `gemma4:26b-a4b-it-q4_K_M` | GGUF 量化 |
| `gemma4-e2b-nothink` | `gemma4:e2b` | GGUF 量化 |

所有别名都会自动关闭思考模式，直接调用原始模型名则不会。

## 配置

编辑 `proxy.config.json`：

```json
{
  "upstreamBaseUrl": "http://127.0.0.1:11434",
  "listenHost": "127.0.0.1",
  "listenPort": 11435,
  "logLevel": "off",
  "aliases": {
    "qwen36-nvfp4-nothink": {
      "target": "qwen3.6:35b-a3b-nvfp4",
      "disableThinking": true
    }
  }
}
```

### 日志

- `"logLevel": "off"` — 不记录请求日志（默认）
- `"logLevel": "debug"` — 记录详细请求日志（排查问题时开启）

修改配置后执行 `ollama-nothink restart` 生效。

## 示例

```bash
curl http://127.0.0.1:11435/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "qwen36-nvfp4-nothink",
    "stream": false,
    "messages": [
      {
        "role": "user",
        "content": "用一句话介绍量子计算"
      }
    ]
  }'
```

## 添加新别名

在 `proxy.config.json` 的 `aliases` 中添加：

```json
"新别名": {
  "target": "ollama中的实际模型名",
  "disableThinking": true
}
```

然后 `ollama-nothink restart`。
