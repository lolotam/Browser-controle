// Model access through a ChatGPT subscription: the Codex backend speaks the
// OpenAI Responses API at chatgpt.com/backend-api/codex.

import { readSse } from '../lib/sse.js';
import { getValidAuth } from './chatgpt-auth.js';

const BASE_URL = 'https://chatgpt.com/backend-api/codex';
// The backend drops models newer than the asking client, so this must track the
// current Codex CLI release (`codex --version`), not live in user settings.
const CODEX_CLIENT_VERSION = '0.160.1';
const KEEP_FULL_OBSERVATIONS = 2;
const TRIMMED_OBSERVATION_CHARS = 400;

async function authHeaders(forceRefresh = false) {
  const auth = await getValidAuth({ forceRefresh });
  const headers = { Authorization: `Bearer ${auth.accessToken}`, originator: 'codex_cli_rs' };
  if (auth.accountId) headers['ChatGPT-Account-ID'] = auth.accountId;
  return headers;
}

/** Lists the models the signed-in plan can use, with their reasoning levels. */
export async function listChatgptModels() {
  const url = `${BASE_URL}/models?client_version=${CODEX_CLIENT_VERSION}`;
  let res = await fetch(url, { credentials: 'omit', headers: await authHeaders() });
  if (res.status === 401) res = await fetch(url, { credentials: 'omit', headers: await authHeaders(true) });
  if (!res.ok) throw new Error(`Could not load models (HTTP ${res.status}).`);
  const { models = [] } = await res.json();
  return models
    .filter((m) => m.visibility !== 'hide' && m.visibility !== 'none')
    .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
    .map((m) => ({
      id: m.slug,
      name: m.display_name ?? m.slug,
      description: m.description ?? '',
      efforts: (m.supported_reasoning_levels ?? []).map((l) => l.effort),
      defaultEffort: m.default_reasoning_level ?? null,
      contextWindow: m.context_window ?? null,
    }));
}

export class ChatgptSession {
  constructor({ model, effort, systemPrompt, tools }) {
    this.model = model;
    this.effort = effort;
    this.systemPrompt = systemPrompt;
    this.tools = tools;
    this.input = [];
    this.pendingImages = [];
    this.sessionId = crypto.randomUUID();
    this.instructionsAsField = true;
  }

  addUserMessage(text, images = []) {
    this.input.push(userMessage(text, images));
  }

  addToolResult(callId, output, images = []) {
    this.input.push({ type: 'function_call_output', call_id: callId, output });
    this.pendingImages.push(...images);
  }

  async next({ signal, onEvent = () => {}, toolChoice = 'auto' }) {
    if (this.pendingImages.length) {
      this.input.push(userMessage('Screenshot returned by the last tool call:', this.pendingImages));
      this.pendingImages = [];
    }
    compactInput(this.input);

    const response = await this.post(toolChoice, signal);
    const items = [];
    let usage = null;
    for await (const { data } of readSse(response, signal)) {
      if (data === '[DONE]') break;
      const event = JSON.parse(data);
      switch (event.type) {
        case 'response.output_text.delta':
          onEvent({ type: 'text-delta', delta: event.delta });
          break;
        case 'response.reasoning_summary_text.delta':
          onEvent({ type: 'reasoning-delta', delta: event.delta });
          break;
        case 'response.reasoning_summary_part.done':
          onEvent({ type: 'reasoning-delta', delta: '\n\n' });
          break;
        case 'response.output_item.done':
          items.push(event.item);
          break;
        case 'response.completed':
          usage = event.response?.usage ?? null;
          break;
        case 'response.failed':
        case 'response.incomplete':
          throw new Error(event.response?.error?.message ?? event.response?.incomplete_details?.reason ?? 'The model response failed.');
        case 'error':
          throw new Error(event.message ?? event.error?.message ?? 'The model returned an error.');
        default:
          break;
      }
    }

    this.input.push(...items.map(withoutId));
    return parseOutput(items, usage);
  }

  async post(toolChoice, signal, { refreshed = false } = {}) {
    const body = {
      model: this.model,
      instructions: this.instructionsAsField ? this.systemPrompt : undefined,
      input: this.instructionsAsField
        ? this.input
        : [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: this.systemPrompt }] }, ...this.input],
      tools: this.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: false })),
      tool_choice: toolChoice,
      parallel_tool_calls: false,
      reasoning: this.effort ? { effort: this.effort, summary: 'auto' } : { summary: 'auto' },
      store: false,
      stream: true,
      include: ['reasoning.encrypted_content'],
      prompt_cache_key: this.sessionId,
    };
    const res = await fetch(`${BASE_URL}/responses`, {
      method: 'POST',
      credentials: 'omit',
      signal,
      headers: {
        ...(await authHeaders(refreshed)),
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'OpenAI-Beta': 'responses=experimental',
        'session-id': this.sessionId,
        session_id: this.sessionId,
      },
      body: JSON.stringify(body),
    });
    if (res.ok) return res;

    const detail = await res.text().catch(() => '');
    if (res.status === 401 && !refreshed) return this.post(toolChoice, signal, { refreshed: true });
    if (res.status === 400 && this.instructionsAsField && /instruction/i.test(detail)) {
      this.instructionsAsField = false;
      return this.post(toolChoice, signal, { refreshed });
    }
    throw new Error(describeError(res.status, detail));
  }
}

function userMessage(text, images) {
  return {
    type: 'message',
    role: 'user',
    content: [
      { type: 'input_text', text },
      ...images.map((url) => ({ type: 'input_image', image_url: url, detail: 'auto' })),
    ],
  };
}

/** With store:false the backend keeps nothing, so server item ids must not be echoed back. */
export function withoutId(item) {
  const { id, ...rest } = item;
  return rest;
}

export function parseOutput(items, usage = null) {
  const text = items
    .filter((i) => i.type === 'message')
    .flatMap((i) => i.content ?? [])
    .filter((c) => c.type === 'output_text')
    .map((c) => c.text)
    .join('');
  const toolCalls = items
    .filter((i) => i.type === 'function_call')
    .map((i) => ({ id: i.call_id, name: i.name, args: safeJson(i.arguments) }));
  return { text, toolCalls, usage };
}

/** Shrinks old page observations and screenshots so long tasks stay within context. */
export function compactInput(input) {
  const outputs = input.filter((i) => i.type === 'function_call_output');
  for (const item of outputs.slice(0, -KEEP_FULL_OBSERVATIONS)) {
    if (typeof item.output === 'string' && item.output.length > TRIMMED_OBSERVATION_CHARS + 50) {
      item.output = `${item.output.slice(0, TRIMMED_OBSERVATION_CHARS)}\n…[older page state trimmed]`;
    }
  }
  const withImages = input.filter((i) => i.type === 'message' && i.content?.some((c) => c.type === 'input_image'));
  for (const message of withImages.slice(0, -1)) {
    message.content = message.content.map((c) => (c.type === 'input_image' ? { type: 'input_text', text: '[older screenshot removed]' } : c));
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text || '{}');
  } catch {
    return { _raw: text };
  }
}

function describeError(status, detail) {
  let message = detail;
  try {
    const parsed = JSON.parse(detail);
    message = parsed.detail ?? parsed.error?.message ?? parsed.message ?? detail;
    if (typeof message !== 'string') message = JSON.stringify(message);
  } catch {
    // Plain-text error body.
  }
  if (status === 429) return `ChatGPT usage limit reached for this plan. ${message}`.trim();
  if (status === 403) return `ChatGPT refused the request (HTTP 403). The plan may not include Codex access, or OpenAI blocked this client. ${message}`.trim();
  return `ChatGPT request failed (HTTP ${status}): ${String(message).slice(0, 400)}`;
}
