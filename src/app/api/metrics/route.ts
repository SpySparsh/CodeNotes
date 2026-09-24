import { NextResponse } from 'next/server';
import { registry } from '@/lib/metrics';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const metrics = await registry.metrics();
  return new NextResponse(metrics, {
    status: 200,
    headers: {
      'Content-Type': registry.contentType,
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    },
  });
}
