export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import type { NextRequest } from 'next/server';
import { createCoder } from '@headless-coder-sdk/core';
import type { PromptInput } from '@headless-coder-sdk/core';
import { loadConfig } from '@/acp/config';
import { ensureAdaptersRegistered } from '@/acp/registry';
import { sessions } from '@/acp/store';
import { verifyRequestAuth } from '@/acp/auth';
import { mapEventToFrames } from '@/acp/mapper';
import { jsonl } from '@/acp/utils';

export async function POST(request: NextRequest) {
  const authError = verifyRequestAuth(request);
  if (authError) return authError;

  const cfg = loadConfig();
  await ensureAdaptersRegistered(cfg);

  const { sessionId, content, outputSchema } = (await request.json()) as {
    sessionId: string;
    content: PromptInput;
    outputSchema?: object;
  };

  if (!sessionId) {
    return new Response('sessionId is required', { status: 400 });
  }

  const session = sessions.get(sessionId);
  if (!session) {
    return new Response('Unknown session', { status: 404 });
  }
  if (!cfg.enabledAgents.includes(session.provider)) {
    return new Response('Provider not enabled', { status: 400 });
  }

  const coder = createCoder(session.provider);
  const thread = session.threadId
    ? await coder.resumeThread(session.threadId)
    : await coder.startThread();

  const url = new URL(request.url);
  const stream = url.searchParams.get('stream') === 'true';

  if (!stream) {
    const result = await thread.run(content, { outputSchema });
    sessions.set(sessionId, { provider: session.provider, threadId: thread.id });
    return Response.json({ text: result.text, json: result.json, usage: result.usage });
  }

  const readable = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of thread.runStreamed(content, { outputSchema })) {
          for (const frame of mapEventToFrames(event)) {
            controller.enqueue(jsonl(frame));
          }
        }
        controller.enqueue(jsonl({ type: 'done' }));
        controller.close();
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        controller.enqueue(jsonl({ type: 'error', message }));
        controller.close();
      } finally {
        sessions.set(sessionId, { provider: session.provider, threadId: thread.id });
      }
    },
  });

  return new Response(readable, {
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-store',
    },
  });
}
