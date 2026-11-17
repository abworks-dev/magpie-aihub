// Translation between the OpenAI shapes a Magpie provider exposes and the
// native Gemini protocol AIHub serves for Gemini groups. Text only: the plugin
// deliberately keeps one model and one platform per attempt.
const id = prefix => `${prefix}_${Math.random().toString(36).slice(2, 12)}`;

const textOf = part => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '');

function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(textOf).join('');
  return '';
}

function toContents(messages) {
  const contents = [];
  for (const message of messages) {
    const role = message?.role === 'assistant' || message?.role === 'model' ? 'model' : 'user';
    const text = contentText(message?.content);
    if (!text) continue;
    contents.push({ role, parts: [{ text }] });
  }
  return contents;
}

/** OpenAI Responses or Chat request → Gemini generateContent request. */
export function toGeminiRequest(body, inbound) {
  const system = [];
  let messages = [];
  let config = {};
  if (inbound === 'chat') {
    for (const message of Array.isArray(body?.messages) ? body.messages : []) {
      if (message?.role === 'system' || message?.role === 'developer') { system.push(contentText(message.content)); continue; }
      messages.push(message);
    }
    config = {
      ...(Number.isFinite(body?.temperature) ? { temperature: body.temperature } : {}),
      ...(Number.isFinite(body?.top_p) ? { topP: body.top_p } : {}),
      ...(Number.isFinite(body?.max_tokens) ? { maxOutputTokens: body.max_tokens } : {}),
    };
  } else {
    if (typeof body?.instructions === 'string') system.push(body.instructions);
    const input = body?.input;
    if (typeof input === 'string') messages = [{ role: 'user', content: input }];
    else if (Array.isArray(input)) messages = input.map(item => ({ role: item?.role ?? 'user', content: item?.content ?? item }));
    config = {
      ...(Number.isFinite(body?.temperature) ? { temperature: body.temperature } : {}),
      ...(Number.isFinite(body?.top_p) ? { topP: body.top_p } : {}),
      ...(Number.isFinite(body?.max_output_tokens) ? { maxOutputTokens: body.max_output_tokens } : {}),
    };
  }
  const gemini = { contents: toContents(messages) };
  const instructions = system.filter(Boolean).join('\n\n');
  if (instructions) gemini.systemInstruction = { parts: [{ text: instructions }] };
  if (Object.keys(config).length) gemini.generationConfig = config;
  return gemini;
}

export const geminiPath = (model, stream) =>
  `/v1beta/models/${encodeURIComponent(model)}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`;

const usageOf = (meta = {}) => ({
  input: Number(meta.promptTokenCount) || 0,
  output: Number(meta.candidatesTokenCount) || 0,
  total: Number(meta.totalTokenCount) || 0,
});

const textOfCandidates = json =>
  (json?.candidates ?? []).flatMap(candidate => candidate?.content?.parts ?? []).map(textOf).join('');

/** Gemini generateContent JSON → the shape the caller asked for. */
export function fromGeminiResponse(json, model, inbound) {
  const text = textOfCandidates(json);
  const usage = usageOf(json?.usageMetadata);
  if (inbound === 'chat') {
    return {
      id: id('chatcmpl'), object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.total || usage.input + usage.output },
    };
  }
  return {
    id: id('resp'), object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', model,
    output: [{ type: 'message', id: id('msg'), role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }],
    usage: { input_tokens: usage.input, output_tokens: usage.output, total_tokens: usage.total || usage.input + usage.output },
    output_text: text,
  };
}

/**
 * Incremental Gemini SSE → caller SSE. Feed decoded text in, write what comes
 * back; call end() for the terminal events. Only text deltas are translated.
 */
export function geminiStream(inbound, model) {
  const created = Math.floor(Date.now() / 1000);
  const responseId = id('resp');
  const itemId = id('msg');
  const chatId = id('chatcmpl');
  let buffer = '';
  let text = '';
  let usage = { input: 0, output: 0, total: 0 };
  let opened = false;
  const frame = (event, payload) => (inbound === 'chat'
    ? `data: ${JSON.stringify(payload)}\n\n`
    : `event: ${event}\ndata: ${JSON.stringify({ type: event, ...payload })}\n\n`);
  const open = () => {
    if (opened || inbound === 'chat') return '';
    opened = true;
    return frame('response.created', { response: { id: responseId, object: 'response', status: 'in_progress', model, output: [] } })
      + frame('response.output_item.added', { output_index: 0, item: { type: 'message', id: itemId, role: 'assistant', status: 'in_progress', content: [] } })
      + frame('response.content_part.added', { item_id: itemId, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
  };
  const push = chunk => {
    buffer += chunk;
    let out = '';
    for (;;) {
      const at = buffer.indexOf('\n\n');
      if (at === -1) break;
      const block = buffer.slice(0, at); buffer = buffer.slice(at + 2);
      out += open();
      for (const line of block.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === '[DONE]') continue;
        let json;
        try { json = JSON.parse(raw); } catch { continue; }
        if (json.usageMetadata) usage = usageOf(json.usageMetadata);
        const delta = textOfCandidates(json);
        if (!delta) continue;
        text += delta;
        out += inbound === 'chat'
          ? `data: ${JSON.stringify({ id: chatId, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] })}\n\n`
          : frame('response.output_text.delta', { item_id: itemId, output_index: 0, content_index: 0, delta });
      }
    }
    return out;
  };
  const end = () => {
    const totals = { input_tokens: usage.input, output_tokens: usage.output, total_tokens: usage.total || usage.input + usage.output };
    if (inbound === 'chat') {
      return `data: ${JSON.stringify({ id: chatId, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: totals.total_tokens } })}\n\ndata: [DONE]\n\n`;
    }
    return open()
      + frame('response.output_text.done', { item_id: itemId, output_index: 0, content_index: 0, text })
      + frame('response.content_part.done', { item_id: itemId, output_index: 0, content_index: 0, part: { type: 'output_text', text, annotations: [] } })
      + frame('response.output_item.done', { output_index: 0, item: { type: 'message', id: itemId, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] } })
      + frame('response.completed', { response: { id: responseId, object: 'response', status: 'completed', model, output: [{ type: 'message', id: itemId, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }], usage: totals } });
  };
  return { push, end, usage: () => usage };
}
