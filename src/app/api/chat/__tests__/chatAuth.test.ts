import test from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { POST } from '../route';

test('Chat API Auth: rejects requests without API key or Admin password', async () => {
  const req = new NextRequest('http://localhost:3000/api/chat', {
    method: 'POST',
    body: JSON.stringify({
      messages: [{ role: 'user', content: 'hello' }],
      modelConfig: {
        provider: 'openrouter',
        model: 'anthropic/claude-haiku-5.5',
      },
    }),
  });

  const res = await POST(req);
  assert.equal(res.status, 401);
  const data = await res.json();
  assert.match(data.error, /API key/i);
});

test('Chat API Auth: accepts correct admin password sortd2026 and uses managed key', async () => {
  const originalFetch = globalThis.fetch;
  let capturedHeaders: any = null;
  let capturedBody: any = null;

  globalThis.fetch = async (url: any, init: any) => {
    capturedHeaders = init?.headers;
    capturedBody = JSON.parse(init?.body || '{}');
    return new Response(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'Hello Admin!' } }],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  };

  try {
    const req = new NextRequest('http://localhost:3000/api/chat', {
      method: 'POST',
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'test prompt' }],
        modelConfig: {
          adminPassword: 'sortd2026',
        },
      }),
    });

    const res = await POST(req);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.message.content, 'Hello Admin!');
    
    // Check that managed key is used
    assert.ok(capturedHeaders['Authorization'].startsWith('Bearer sk-or-v1-'));
    // Check default model is Claude Haiku 5.5
    assert.equal(capturedBody.model, 'anthropic/claude-haiku-5.5');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Chat API Auth: rejects incorrect admin password', async () => {
  const req = new NextRequest('http://localhost:3000/api/chat', {
    method: 'POST',
    body: JSON.stringify({
      messages: [{ role: 'user', content: 'hello' }],
      modelConfig: {
        adminPassword: 'wrong-password',
      },
    }),
  });

  const res = await POST(req);
  assert.equal(res.status, 401);
});

test('Chat API Auth: BYOK client API key takes precedence', async () => {
  const originalFetch = globalThis.fetch;
  let capturedHeaders: any = null;

  globalThis.fetch = async (url: any, init: any) => {
    capturedHeaders = init?.headers;
    return new Response(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'Custom Key OK' } }],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  };

  try {
    const req = new NextRequest('http://localhost:3000/api/chat', {
      method: 'POST',
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'test BYOK' }],
        modelConfig: {
          apiKey: 'user-custom-key-12345',
        },
      }),
    });

    const res = await POST(req);
    assert.equal(res.status, 200);
    assert.equal(capturedHeaders['Authorization'], 'Bearer user-custom-key-12345');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
