// Any OpenAI-compatible Chat Completions endpoint: xAI Grok, Z.ai GLM,
// OpenAI API keys, OpenRouter, or a local server.

import { readSse } from '../lib/sse.js';

const KEEP_FULL_OBSERVATIONS = 2;
const TRIMMED_OBSERVATION_CHARS = 400;
// Gateways such as Vercel's list image, video and embedding models next to chat models.
const NON_CHAT_TYPES = new Set(['embedding', 'image', 'video', 'reranking', 'speech', 'transcription', 'realtime', 'evaluation']);

export async function listCompatibleModels(baseUrl, apiKey) {
  const res = await fetch(`${trimSlash(baseUrl)}/models`, {
    credentials: 'omit',
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  });
  if (!res.ok) throw new Error(`Could not load models (HTTP ${res.status}). Type the model id manually.`);
  const body = await res.json();
  return (body.data ?? body.models ?? [])
    .filter((m) => !NON_CHAT_TYPES.has(m.type))
    .map((m) => ({ id: m.id ?? m.name, name: m.id ?? m.name, efforts: [] }));
}

export class CompatibleSession {
  constructor({ baseUrl, apiKey, model, effort, thinkingStyle, systemPrompt, tools }) {
    this.baseUrl = trimSlash(baseUrl);
    this.apiKey = apiKey;
    this.model = model;
    this.effort = effort;
    this.thinkingStyle = thinkingStyle;
    this.tools = tools;
    this.messages = [{ role: 'system', content: systemPrompt }];
    this.pendingImages = [];
  }

  addUserMessage(text, images = []) {
    this.messages.push(userMessage(text, images));
  }

  addToolResult(callId, output, images = []) {
    this.messages.push({ role: 'tool', tool_call_id: callId, content: output });
    this.pendingImages.push(...images);
  }

  async next({ signal, onEvent = () => {}, toolChoice = 'auto' }) {
    if (this.pendingImages.length) {
      this.messages.push(userMessage('Screenshot returned by the last tool call:', this.pendingImages));
      this.pendingImages = [];
    }
    compactMessages(this.messages);

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      credentials: 'omit',
      signal,
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify(this.requestBody(toolChoice)),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Model request failed (HTTP ${res.status}): ${detail.slice(0, 400)}`);
    }

    const acc = createAccumulator();
    for await (const { data } of readSse(res, signal)) {
      if (data === '[DONE]') break;
      const chunk = JSON.parse(data);
      if (chunk.error) throw new Error(chunk.error.message ?? JSON.stringify(chunk.error));
      const delta = acc.push(chunk);
      if (delta.text) onEvent({ type: 'text-delta', delta: delta.text });
      if (delta.reasoning) onEvent({ type: 'reasoning-delta', delta: delta.reasoning });
    }

    const result = acc.result();
    this.messages.push({
      role: 'assistant',
      content: result.text || null,
      ...(result.rawToolCalls.length ? { tool_calls: result.rawToolCalls } : {}),
    });
    return { text: result.text, toolCalls: result.toolCalls, usage: result.usage };
  }

  requestBody(toolChoice) {
    const body = {
      model: this.model,
      messages: this.messages,
      tools: this.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
      tool_choice: toolChoice,
      stream: true,
    };
    if (this.thinkingStyle === 'glm') {
      if (this.effort) body.thinking = { type: this.effort === 'off' ? 'disabled' : 'enabled' };
    } else if (this.effort && this.effort !== 'off') {
      body.reasoning_effort = this.effort;
    }
    return body;
  }
}

/** Reassembles streamed Chat Completions deltas, including split tool-call arguments. */
export function createAccumulator() {
  let text = '';
  let usage = null;
  const calls = [];
  return {
    push(chunk) {
      if (chunk.usage) usage = chunk.usage;
      const delta = chunk.choices?.[0]?.delta ?? {};
      const out = { text: delta.content ?? '', reasoning: delta.reasoning_content ?? delta.reasoning ?? '' };
      text += out.text;
      for (const tc of delta.tool_calls ?? []) {
        const i = tc.index ?? calls.length;
        calls[i] ??= { id: '', name: '', arguments: '' };
        if (tc.id) calls[i].id = tc.id;
        if (tc.function?.name) calls[i].name += tc.function.name;
        if (tc.function?.arguments) calls[i].arguments += tc.function.arguments;
      }
      return out;
    },
    result() {
      const present = calls.filter(Boolean).map((c, n) => ({ ...c, id: c.id || `call_${n}_${Date.now()}` }));
      return {
        text,
        usage,
        rawToolCalls: present.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments || '{}' } })),
        toolCalls: present.map((c) => ({ id: c.id, name: c.name, args: safeJson(c.arguments) })),
      };
    },
  };
}

export function compactMessages(messages) {
  const toolMessages = messages.filter((m) => m.role === 'tool');
  for (const m of toolMessages.slice(0, -KEEP_FULL_OBSERVATIONS)) {
    if (typeof m.content === 'string' && m.content.length > TRIMMED_OBSERVATION_CHARS + 50) {
      m.content = `${m.content.slice(0, TRIMMED_OBSERVATION_CHARS)}\n…[older page state trimmed]`;
    }
  }
  const withImages = messages.filter((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((c) => c.type === 'image_url'));
  for (const m of withImages.slice(0, -1)) {
    m.content = m.content.map((c) => (c.type === 'image_url' ? { type: 'text', text: '[older screenshot removed]' } : c));
  }
}

function userMessage(text, images) {
  if (!images.length) return { role: 'user', content: text };
  return {
    role: 'user',
    content: [{ type: 'text', text }, ...images.map((url) => ({ type: 'image_url', image_url: { url } }))],
  };
}

function safeJson(text) {
  try {
    return JSON.parse(text || '{}');
  } catch {
    return { _raw: text };
  }
}

function trimSlash(url) {
  return String(url).replace(/\/+$/, '');
}
