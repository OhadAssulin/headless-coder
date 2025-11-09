import type { NextRequest } from 'next/server';
import { env } from '@/env';

export function verifyRequestAuth(request: NextRequest): Response | null {
  if (!env.acpToken) return null;
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) {
    return new Response('Missing ACP token', { status: 401 });
  }
  const token = header.slice('Bearer '.length).trim();
  if (token !== env.acpToken) {
    return new Response('Invalid ACP token', { status: 403 });
  }
  return null;
}
