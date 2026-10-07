# Browser Controle — AI agent that operates your Chrome

A Chrome side-panel extension. Give it a task in Arabic or English and it carries it out in your real browser, one step at a time: it searches, clicks, types, picks from menus, scrolls, switches tabs, and reads and collects information. When it finishes, it returns a **final report** with the results and sources.

**Current focus:** it runs on the model access included in your **ChatGPT plan**, the same sign-in the official Codex CLI uses. You choose the model and the reasoning effort. Other providers come later.

👉 **[Full setup guide → docs/SETUP.md](docs/SETUP.md)** · Arabic overview: [docs/README.ar.md](docs/README.ar.md)

## Quick start

1. Clone the repo:
   ```bash
   git clone https://github.com/lolotam/Browser-controle.git
   ```
2. In `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and select the repo folder.
3. Open the side panel (**Alt+Shift+A**) and click **Sign in with ChatGPT**. Enter the code shown in the panel at `auth.openai.com/codex/device`.
4. Pick a model and a reasoning effort, then click **Save**.
5. Open any website and type a task.

## Features

- **Trusted input:** clicks and keystrokes go through the Chrome DevTools Protocol, so they work on sites that ignore synthetic events.
- **Page understanding:** numbered interactive elements (including inside shadow DOM), visible text, and screenshots for vision-capable models.
- **Tools:** navigate, search, click, type, press keys, select options, hover, scroll, read long pages, history, and tab management. JavaScript extraction is optional.
- **Safety:** the agent must ask you before payments, sending messages, deleting data or typing passwords. Page text is treated as untrusted.
- **Optional fast layer:** a ⚡ layer based on TypeSafe's Jev decision model can run confident steps without an LLM call. It is experimental.

## Status

| Part | State |
|---|---|
| Browser control + agent loop | ✅ Covered by unit tests and a Chromium end-to-end test (mock model) |
| Codex / ChatGPT subscription | 🟡 Implemented from the Codex CLI source and tested with mocks; **needs validation on a real account** |
| Other providers (Grok, GLM, OpenAI API, OpenRouter) | ⏳ Code exists but has not been tested with the real services; planned |
| Jev fast layer | ⏳ Experimental, tested with mocks only |

> Using a ChatGPT plan outside OpenAI's own apps is unofficial. OpenAI may change or block it at any time.

## Development

```bash
npm test                  # unit tests
npm install && npm run e2e
```
