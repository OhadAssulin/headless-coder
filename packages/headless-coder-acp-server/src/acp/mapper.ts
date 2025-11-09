import type { AcpStreamFrame } from '@i-am-bee/acp-sdk';
import type { CoderStreamEvent } from '@headless-coder-sdk/core';

const frame = (payload: Record<string, unknown>): AcpStreamFrame => payload as AcpStreamFrame;

export function mapEventToFrames(event: CoderStreamEvent): AcpStreamFrame[] {
  switch (event.type) {
    case 'message':
      return [
        frame({
          type: 'message',
          role: event.role,
          text: event.text,
          delta: event.delta ?? false,
          provider: event.provider,
          ts: event.ts,
        }),
      ];
    case 'tool_use':
      return [
        frame({
          type: 'tool_call',
          name: event.name,
          callId: event.callId,
          args: event.args,
          provider: event.provider,
          ts: event.ts,
        }),
      ];
    case 'tool_result':
      return [
        frame({
          type: 'tool_result',
          name: event.name,
          callId: event.callId,
          result: event.result,
          exitCode: event.exitCode,
          provider: event.provider,
          ts: event.ts,
        }),
      ];
    case 'usage':
      return [frame({ type: 'usage', provider: event.provider, stats: event.stats, ts: event.ts })];
    case 'progress':
      return [frame({ type: 'progress', label: event.label, detail: event.detail, provider: event.provider, ts: event.ts })];
    case 'permission':
      return [frame({ type: 'permission', decision: event.decision, request: event.request, provider: event.provider, ts: event.ts })];
    case 'file_change':
      return [frame({ type: 'file_change', path: event.path, op: event.op, provider: event.provider, ts: event.ts })];
    case 'plan_update':
      return [frame({ type: 'plan_update', text: event.text, provider: event.provider, ts: event.ts })];
    case 'error':
      return [frame({ type: 'error', code: event.code, message: event.message, provider: event.provider, ts: event.ts })];
    case 'cancelled':
      return [frame({ type: 'cancelled', provider: event.provider, ts: event.ts })];
    case 'done':
      return [frame({ type: 'done', provider: event.provider, ts: event.ts })];
    case 'init':
      return [frame({ type: 'init', provider: event.provider, threadId: event.threadId, ts: event.ts })];
    default:
      return [frame({ type: 'event', provider: event.provider, ts: event.ts, original: event })];
  }
}
