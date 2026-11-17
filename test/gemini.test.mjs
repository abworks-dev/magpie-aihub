import { test } from 'node:test';
import assert from 'node:assert/strict';
import { geminiPath, toGeminiRequest, fromGeminiResponse, geminiStream } from '../src/gemini.mjs';

const sse = (...chunks) => chunks.map(json => `data: ${JSON.stringify(json)}\n\n`).join('');

test('a responses request is converted into a generateContent request', () => {
  const gemini = toGeminiRequest({
    instructions: 'be brief',
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
    temperature: 0.2, top_p: 0.9, max_output_tokens: 64,
  }, 'responses');
  assert.deepEqual(gemini.contents, [{ role: 'user', parts: [{ text: 'hello' }] }]);
  assert.deepEqual(gemini.systemInstruction, { parts: [{ text: 'be brief' }] });
  assert.deepEqual(gemini.generationConfig, { temperature: 0.2, topP: 0.9, maxOutputTokens: 64 });
});

test('a chat request maps roles and a string system message', () => {
  const gemini = toGeminiRequest({
    messages: [
      { role: 'system', content: 'stay calm' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: [{ type: 'text', text: 'bye' }] },
    ],
    max_tokens: 12,
  }, 'chat');
  assert.deepEqual(gemini.contents, [
    { role: 'user', parts: [{ text: 'hi' }] },
    { role: 'model', parts: [{ text: 'hello' }] },
    { role: 'user', parts: [{ text: 'bye' }] },
  ]);
  assert.deepEqual(gemini.systemInstruction, { parts: [{ text: 'stay calm' }] });
  assert.deepEqual(gemini.generationConfig, { maxOutputTokens: 12 });
});

test('the target path selects streaming or not and keeps the model name intact', () => {
  assert.equal(geminiPath('gemini-3.8-flash', false), '/v1beta/models/gemini-3.8-flash:generateContent');
  assert.equal(geminiPath('gemini-3.8-flash', true), '/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse');
});

test('a generateContent answer becomes a chat completion or a response', () => {
  const json = { candidates: [{ content: { parts: [{ text: 'pong' }] } }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 } };
  const chat = fromGeminiResponse(json, 'gemini::g', 'chat');
  assert.equal(chat.choices[0].message.content, 'pong');
  assert.deepEqual(chat.usage, { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
  const response = fromGeminiResponse(json, 'gemini::g', 'responses');
  assert.equal(response.output_text, 'pong');
  assert.equal(response.output[0].content[0].type, 'output_text');
  assert.deepEqual(response.usage, { input_tokens: 3, output_tokens: 2, total_tokens: 5 });
});

test('the stream translator forwards text deltas and closes the response', () => {
  const translator = geminiStream('responses', 'gemini::g');
  const head = translator.push(sse({ candidates: [{ content: { parts: [{ text: 'po' }] } }] })).split('\n\n');
  assert.ok(head.some(block => block.includes('response.created')));
  assert.ok(head.some(block => block.includes('"delta":"po"')));
  const tail = translator.push(sse({ candidates: [{ content: { parts: [{ text: 'ng' }] } }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 } }));
  assert.ok(tail.includes('"delta":"ng"'));
  const end = translator.end();
  assert.ok(end.includes('response.completed'));
  assert.ok(end.includes('"total_tokens":5'));
});

test('the chat stream translator emits chunks and the done marker', () => {
  const translator = geminiStream('chat', 'gemini::g');
  const out = translator.push(sse({ candidates: [{ content: { parts: [{ text: 'hi' }] } }] }));
  assert.ok(out.startsWith('data: {'));
  assert.ok(out.includes('"content":"hi"'));
  assert.ok(translator.end().endsWith('data: [DONE]\n\n'));
});

test('a chunk split across reads is still parsed once complete', () => {
  const translator = geminiStream('chat', 'gemini::g');
  const whole = sse({ candidates: [{ content: { parts: [{ text: 'split' }] } }] });
  const first = translator.push(whole.slice(0, 20));
  assert.equal(first, '');
  const rest = translator.push(whole.slice(20));
  assert.ok(rest.includes('"content":"split"'));
});
