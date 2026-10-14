# Models

Claude, OpenAI-compatible providers, local models, prices and context windows.

## Models

`-m` (or `GARUDA_MODEL`) takes a Claude model id, or `<provider>/<model>` for other providers:

```sh
g -m claude-sonnet-5                 # Anthropic (ANTHROPIC_API_KEY)
g -m ollama/qwen3-coder:30b          # Ollama on this machine
g -m lmstudio/<model>                # LM Studio (also: llamacpp/…, vllm/…)
g -m openrouter/qwen/qwen3-coder     # OpenRouter (OPENROUTER_API_KEY)
g eval -m ollama/qwen3-coder:30b -s hard   # measure an open model on the eval tasks
```

Set the context window, price and output limit per model, and add providers, in `~/.garuda/models.json`:

```json
{
  "providers": { "lab": { "type": "openai-compatible", "baseUrl": "https://llm.example.com/v1", "apiKeyEnv": "LAB_KEY" } },
  "models": { "ollama/qwen3-coder:30b": { "contextWindow": 65536, "maxTokens": 8192 } },
  "default": "ollama/qwen3-coder:30b"
}
```

- Only this file in your home folder can define providers; a project cannot send your code elsewhere.
  Keys come from environment variables. Plain http works only to this machine (or with
  `"allowInsecureHttp": true`).
- `"default"` is the model when neither `--model` nor `GARUDA_MODEL` names one.
- Some small models write a tool call as JSON text. When the whole reply is such a call to a known
  tool, Garuda runs it as a real call, with the usual approvals. For a model that also writes
  sentences around the call (for example `qwen2.5-coder:7b`), set `"textToolCalls": "lines"` for that
  model: then a call on its own line runs too. A call in the middle of a sentence never runs.
- Without a `contextWindow`, Garuda assumes 32 768 tokens for open models and says so. The server must
  allow the window too: for Ollama, start it with `OLLAMA_CONTEXT_LENGTH=65536 ollama serve`.
- Local models cost $0. Tool calling quality varies by model: measure a model with `g eval` first.
