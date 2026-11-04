import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { messages, systemPrompt, tools, modelConfig } = body;

    const provider = modelConfig?.provider || 'openrouter';
    const model = modelConfig?.model || 'google/gemini-2.5-flash';
    const clientApiKey = modelConfig?.apiKey?.trim();

    // Resolve API key with BYOK priority: Client settings > Env vars
    const apiKey =
      clientApiKey ||
      process.env.OPENROUTER_API_KEY ||
      process.env.OPENAI_API_KEY;

    if (!apiKey) {
      return NextResponse.json(
        {
          error:
            'No API key provided. Please configure your OpenRouter / OpenAI API key in Workbench Settings (Gear icon) or set OPENROUTER_API_KEY in your .env.',
        },
        { status: 401 }
      );
    }

    let endpoint = 'https://openrouter.ai/api/v1/chat/completions';
    if (provider === 'openai') {
      endpoint = 'https://api.openai.com/v1/chat/completions';
    } else if (modelConfig?.baseUrl) {
      endpoint = `${modelConfig.baseUrl.replace(/\/$/, '')}/chat/completions`;
    }

    // Format system prompt and messages
    const formattedMessages = [
      ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
      ...messages,
    ];

    // Format tools in OpenAI standard format
    const formattedTools =
      tools && Array.isArray(tools) && tools.length > 0
        ? tools.map((t: any) => ({
            type: 'function',
            function: {
              name: t.name,
              description: t.description,
              parameters: t.parameters || { type: 'object', properties: {} },
            },
          }))
        : undefined;

    const payload: any = {
      model,
      messages: formattedMessages,
      temperature: modelConfig?.temperature ?? 0.2,
    };

    if (formattedTools && formattedTools.length > 0) {
      payload.tools = formattedTools;
      payload.tool_choice = 'auto';
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    };

    if (endpoint.includes('openrouter.ai')) {
      headers['HTTP-Referer'] = 'https://sortd.local';
      headers['X-Title'] = 'Sortd Spreadsheet Studio';
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      signal: req.signal,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errText = await response.text();
      let parsedErr: any = null;
      try {
        parsedErr = JSON.parse(errText);
      } catch {
        parsedErr = null;
      }

      const errorMessage =
        parsedErr?.error?.message ||
        `Upstream provider error (${response.status}): ${errText.slice(0, 300)}`;

      return NextResponse.json({ error: errorMessage }, { status: response.status });
    }

    const completion = await response.json();
    const choice = completion.choices?.[0];
    const assistantMessage = choice?.message || {
      role: 'assistant',
      content: 'No response generated.',
    };

    return NextResponse.json({
      message: assistantMessage,
      finish_reason: choice?.finish_reason,
      usage: completion.usage,
    });
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      return NextResponse.json({ error: 'Request aborted by user.' }, { status: 499 });
    }
    console.error('API /api/chat error:', error);
    return NextResponse.json(
      { error: error?.message || 'Internal server error in chat orchestrator.' },
      { status: 500 }
    );
  }
}
