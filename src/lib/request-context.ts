import crypto from 'crypto';

export function getRequestId(request?: Request): string {
  if (!request) {
    return crypto.randomUUID();
  }
  const existing = request.headers.get('x-request-id');
  if (existing && existing.trim().length > 0) {
    return existing.trim();
  }
  return crypto.randomUUID();
}
