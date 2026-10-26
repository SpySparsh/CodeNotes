import { z } from 'zod';
import crypto from 'crypto';
import { logger } from '@/lib/logger';
import { recordAiRequest, recordAiDuration } from '@/lib/metrics';
import { withSpan, SpanStatusCode, sanitizeErrorMessage, createSafeSpan, type Span } from '@/lib/tracing';

export const DEFAULT_AI_TIMEOUT_MS = 85_000;
export const DEFAULT_AI_MODEL = 'gemini-2.5-flash';

/**
 * Runtime Zod schema validating the structured notes contract returned by FastAPI.
 * Allows empty arrays for keyConcepts and shorthands matching the upstream specification.
 */
export const generatedNotesSchema = z.object({
  overview: z.string().min(1, 'overview is required and must not be empty'),
  keyConcepts: z.array(z.string()),
  detailedNotes: z.string().min(1, 'detailedNotes is required and must not be empty'),
  shorthands: z.array(z.string()),
});

export type GeneratedNotes = z.infer<typeof generatedNotesSchema>;

export interface GenerateAiNotesOptions {
  requestId?: string;
  timeoutMs?: number;
  serviceUrl?: string;
  serviceSecret?: string;
  model?: string;
  vercelProtectionBypass?: string;
  requireVercelProtectionBypass?: boolean;
  span?: Span;
}

/**
 * Standard typed application error for AI generation client failures.
 */
export class AiClientError extends Error {
  readonly code: string;
  readonly isRetryable: boolean;
  readonly statusCode?: number;
  readonly requestId?: string;

  constructor(options: {
    code: string;
    message: string;
    isRetryable: boolean;
    statusCode?: number;
    requestId?: string;
    cause?: unknown;
  }) {
    super(options.message);
    this.name = 'AiClientError';
    this.code = options.code;
    this.isRetryable = options.isRetryable;
    this.statusCode = options.statusCode;
    this.requestId = options.requestId;
    if (options.cause) {
      this.cause = options.cause;
    }
  }
}

/**
 * Validates and resolves FastAPI configuration settings.
 * Fails closed if settings are missing, if non-local destinations use unencrypted HTTP,
 * or if the Vercel protection bypass token is missing in protected preview configurations.
 */
export function getAiClientConfig(options?: GenerateAiNotesOptions): {
  serviceUrl: string;
  serviceSecret: string;
  timeoutMs: number;
  vercelProtectionBypass?: string;
} {
  const serviceUrl = options?.serviceUrl || process.env.FASTAPI_SERVICE_URL;
  const serviceSecret = options?.serviceSecret || process.env.FASTAPI_SERVICE_SECRET;
  const timeoutMs =
    options?.timeoutMs ??
    (process.env.FASTAPI_TIMEOUT_MS ? parseInt(process.env.FASTAPI_TIMEOUT_MS, 10) : DEFAULT_AI_TIMEOUT_MS);
  const vercelProtectionBypass =
    options?.vercelProtectionBypass || process.env.FASTAPI_VERCEL_PROTECTION_BYPASS;

  if (!serviceUrl || serviceUrl.trim().length === 0) {
    throw new AiClientError({
      code: 'CONFIG_ERROR',
      message: 'FASTAPI_SERVICE_URL is not configured.',
      isRetryable: false,
    });
  }

  if (
    !serviceSecret ||
    serviceSecret.trim().length === 0 ||
    serviceSecret === 'your_fastapi_service_secret_here'
  ) {
    throw new AiClientError({
      code: 'CONFIG_ERROR',
      message: 'FASTAPI_SERVICE_SECRET is not configured or is a placeholder.',
      isRetryable: false,
    });
  }

  let parsed: URL;
  try {
    parsed = new URL(serviceUrl);
  } catch (err) {
    throw new AiClientError({
      code: 'CONFIG_ERROR',
      message: `FASTAPI_SERVICE_URL is not a valid URL: ${serviceUrl}`,
      isRetryable: false,
      cause: err,
    });
  }

  // Security rule: Allow HTTP only for local development (localhost / 127.0.0.1 / ::1).
  // Remote non-local destinations MUST use HTTPS so the shared bearer token is never sent unencrypted.
  const isLocalhost =
    parsed.hostname === 'localhost' ||
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === '::1' ||
    parsed.hostname === '[::1]';

  if (parsed.protocol === 'http:' && !isLocalhost) {
    throw new AiClientError({
      code: 'CONFIG_ERROR',
      message: 'FASTAPI_SERVICE_URL must use HTTPS for remote endpoints to protect service credentials.',
      isRetryable: false,
    });
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AiClientError({
      code: 'CONFIG_ERROR',
      message: `FASTAPI_SERVICE_URL protocol '${parsed.protocol}' is invalid. Must be http: or https:.`,
      isRetryable: false,
    });
  }

  const isBypassPlaceholder =
    vercelProtectionBypass === 'your_vercel_protection_bypass_secret_here' ||
    vercelProtectionBypass === 'your_bypass_secret_here' ||
    vercelProtectionBypass === 'change_me_to_a_secure_random_string';

  if (vercelProtectionBypass && isBypassPlaceholder) {
    throw new AiClientError({
      code: 'CONFIG_ERROR',
      message: 'FASTAPI_VERCEL_PROTECTION_BYPASS is configured as a placeholder.',
      isRetryable: false,
    });
  }

  const isProtectedPreview =
    options?.requireVercelProtectionBypass === true ||
    process.env.FASTAPI_REQUIRE_VERCEL_PROTECTION_BYPASS === 'true' ||
    (!isLocalhost &&
      (process.env.VERCEL_ENV === 'preview' ||
        (parsed.hostname.endsWith('.vercel.app') &&
          (parsed.hostname.includes('-git-') || parsed.hostname.includes('preview')))));

  if (isProtectedPreview) {
    if (!vercelProtectionBypass || vercelProtectionBypass.trim().length === 0) {
      throw new AiClientError({
        code: 'CONFIG_ERROR',
        message: 'FASTAPI_VERCEL_PROTECTION_BYPASS is required for Vercel protected preview deployments.',
        isRetryable: false,
      });
    }
  }

  return {
    serviceUrl: serviceUrl.replace(/\/+$/, ''),
    serviceSecret,
    timeoutMs,
    vercelProtectionBypass: vercelProtectionBypass?.trim() || undefined,
  };
}

export const SAFE_REQUEST_ID_REGEX = /^[a-zA-Z0-9_\-\.]{1,64}$/;

/**
 * Normalizes and sanitizes a request/correlation ID to match the allowed character set
 * across services (alphanumeric, hyphens, underscores, dots, 1-64 chars).
 * Decouples external custom formats without losing tracing correlation.
 */
export function normalizeRequestId(incoming?: string): string {
  if (!incoming || incoming.trim().length === 0) {
    return crypto.randomUUID();
  }
  const trimmed = incoming.trim();
  if (SAFE_REQUEST_ID_REGEX.test(trimmed)) {
    return trimmed;
  }
  const sanitized = trimmed.replace(/[^a-zA-Z0-9_\-\.]/g, '_').slice(0, 64);
  if (sanitized.length > 0 && SAFE_REQUEST_ID_REGEX.test(sanitized)) {
    return sanitized;
  }
  return crypto.randomUUID();
}

/**
 * Invoke the standalone FastAPI microservice to generate structured technical notes.
 * Validates responses using Zod before returning to the caller.
 * Never logs credentials, transcripts, prompts, or generated notes.
 */
export async function generateAiNotes(
  transcript: string,
  videoTitle: string,
  options?: GenerateAiNotesOptions
): Promise<GeneratedNotes> {
  const model = options?.model || process.env.GEMINI_MODEL || DEFAULT_AI_MODEL;
  const rawRequestId = options?.requestId;
  const requestId = normalizeRequestId(rawRequestId);

  if (rawRequestId && rawRequestId !== requestId) {
    logger.info('ai_client_request_id_normalized', {
      originalRequestId: rawRequestId,
      normalizedRequestId: requestId,
    });
  }

  // Validate inputs
  if (!transcript || transcript.trim().length === 0) {
    throw new AiClientError({
      code: 'INVALID_REQUEST',
      message: 'Transcript text is required for AI note generation.',
      isRetryable: false,
      requestId,
    });
  }

  if (!videoTitle || videoTitle.trim().length === 0) {
    throw new AiClientError({
      code: 'INVALID_REQUEST',
      message: 'Video title is required for AI note generation.',
      isRetryable: false,
      requestId,
    });
  }

  const { serviceUrl, serviceSecret, timeoutMs, vercelProtectionBypass } = getAiClientConfig(options);
  const endpoint = `${serviceUrl}/api/v1/generate`;
  const startTime = performance.now();

  logger.info('ai_client_request_started', {
    requestId,
    model,
    transcriptLength: transcript.length,
    videoTitleLength: videoTitle.length,
    timeoutMs,
  });

  const executeWithSpan = async (span: Span): Promise<GeneratedNotes> => {
    const safeSpan = createSafeSpan(span);

    safeSpan.setAttribute('http.request.method', 'POST');
    safeSpan.setAttribute('http.route', '/api/v1/generate');
    safeSpan.setAttribute('model', model);

      const abortController = new AbortController();
      const timer = setTimeout(() => {
        abortController.abort();
      }, timeoutMs);

      let response: Response;
      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${serviceSecret}`,
          'X-Request-ID': requestId,
        };

        if (vercelProtectionBypass) {
          headers['x-vercel-protection-bypass'] = vercelProtectionBypass;
        }

        response = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            transcript,
            videoTitle,
          }),
          signal: abortController.signal,
        });

        safeSpan.setAttribute('http.response.status_code', response.status);
        if (!response.ok) {
          safeSpan.setStatus({
            code: SpanStatusCode.ERROR,
            message: `HTTP ${response.status}`,
          });
        }
      } catch (networkError: any) {
      clearTimeout(timer);
      const durationSeconds = (performance.now() - startTime) / 1000;

      safeSpan.setStatus({
        code: SpanStatusCode.ERROR,
        message: sanitizeErrorMessage(networkError?.message || 'Network error'),
      });
      safeSpan.recordException({
        name: typeof networkError?.code === 'string' ? networkError.code : (networkError?.name || 'NetworkError'),
        message: sanitizeErrorMessage(networkError?.message || 'Network error'),
      });

      const isTimeout =
        networkError?.name === 'AbortError' ||
        networkError?.name === 'TimeoutError' ||
        networkError?.message?.includes('aborted') ||
        networkError?.message?.includes('timeout');

      if (isTimeout) {
        recordAiRequest(model, 'error');
        recordAiDuration(model, durationSeconds);
        logger.warn('ai_client_request_timeout', {
          requestId,
          model,
          timeoutMs,
          durationMs: durationSeconds * 1000,
        });
        throw new AiClientError({
          code: 'TIMEOUT',
          message: `AI generation timed out after ${timeoutMs / 1000} seconds.`,
          isRetryable: true,
          requestId,
          cause: networkError,
        });
      }

      // Inspect socket/DNS error causes
      const causeCode = (networkError?.cause as any)?.code || networkError?.code || '';
      const isDnsFailure = causeCode === 'ENOTFOUND';
      const isConnectionRefused = causeCode === 'ECONNREFUSED';
      const isConnectionReset = causeCode === 'ECONNRESET' || causeCode === 'ETIMEDOUT';

      recordAiRequest(model, 'error');
      recordAiDuration(model, durationSeconds);

      logger.error('ai_client_network_error', {
        requestId,
        model,
        durationMs: durationSeconds * 1000,
        causeCode,
        errorMessage: networkError?.message,
      });

      if (isDnsFailure) {
        throw new AiClientError({
          code: 'CONFIG_ERROR',
          message: 'Failed to resolve AI generation service host.',
          isRetryable: false,
          requestId,
          cause: networkError,
        });
      }

      if (isConnectionReset) {
        throw new AiClientError({
          code: 'TIMEOUT',
          message: 'Connection to AI generation service was reset or timed out. Retrying...',
          isRetryable: true,
          requestId,
          cause: networkError,
        });
      }

      throw new AiClientError({
        code: 'NETWORK_ERROR',
        message: isConnectionRefused
          ? 'Connection to AI generation service was refused. Retrying...'
          : (networkError?.message || 'Failed to communicate with AI generation service.'),
        isRetryable: true,
        requestId,
        cause: networkError,
      });
    } finally {
      clearTimeout(timer);
    }

    const durationSeconds = (performance.now() - startTime) / 1000;
    const serverRequestId = response.headers.get('x-request-id');
    const effectiveRequestId = serverRequestId || requestId;

    if (serverRequestId && serverRequestId !== requestId) {
      logger.info('ai_client_request_id_server_divergence', {
        clientRequestId: requestId,
        serverRequestId,
      });
    }

    // Handle unsuccessful HTTP statuses
    if (!response.ok) {
      let errorPayload: any = null;
      try {
        errorPayload = await response.json();
      } catch {
        // Non-JSON response (e.g. reverse proxy HTML 502/504)
      }

      const returnedCode: string = errorPayload?.error?.code || '';
      const returnedMessage: string = errorPayload?.error?.message || '';

      logger.warn('ai_client_request_failed', {
        requestId: effectiveRequestId,
        model,
        status: response.status,
        returnedCode,
        durationMs: durationSeconds * 1000,
      });

      // HTTP 401 Unauthorized -> misconfigured secret
      if (response.status === 401) {
        recordAiRequest(model, 'error');
        recordAiDuration(model, durationSeconds);
        throw new AiClientError({
          code: 'CONFIG_ERROR',
          message: 'AI generation service authentication failed.',
          isRetryable: false,
          statusCode: 401,
          requestId: effectiveRequestId,
        });
      }

      // HTTP 422 Invalid Request
      if (response.status === 422) {
        recordAiRequest(model, 'error');
        recordAiDuration(model, durationSeconds);
        throw new AiClientError({
          code: 'INVALID_REQUEST',
          message: returnedMessage || 'Invalid request payload sent to AI service.',
          isRetryable: false,
          statusCode: 422,
          requestId: effectiveRequestId,
        });
      }

      // HTTP 429 Rate Limited
      if (response.status === 429 || returnedCode === 'RATE_LIMITED') {
        recordAiRequest(model, 'error');
        recordAiDuration(model, durationSeconds);
        throw new AiClientError({
          code: 'RATE_LIMITED',
          message: returnedMessage || 'Generation service is temporarily busy. Retrying...',
          isRetryable: true,
          statusCode: 429,
          requestId: effectiveRequestId,
        });
      }

      // HTTP 502 Bad Gateway -> Distinguish MALFORMED_OUTPUT from UPSTREAM_ERROR
      if (response.status === 502) {
        if (returnedCode === 'MALFORMED_OUTPUT') {
          recordAiRequest(model, 'malformed_output');
          recordAiDuration(model, durationSeconds);
          throw new AiClientError({
            code: 'MALFORMED_AI_OUTPUT',
            message: 'The AI model output could not be parsed into notes format.',
            isRetryable: false,
            statusCode: 502,
            requestId: effectiveRequestId,
          });
        }

        recordAiRequest(model, 'error');
        recordAiDuration(model, durationSeconds);
        throw new AiClientError({
          code: 'UPSTREAM_ERROR',
          message: returnedMessage || 'Upstream AI provider error occurred. Retrying...',
          isRetryable: true,
          statusCode: 502,
          requestId: effectiveRequestId,
        });
      }

      // HTTP 503 Service Unavailable -> Distinguish CONFIG_ERROR from transient 503
      if (response.status === 503) {
        recordAiRequest(model, 'error');
        recordAiDuration(model, durationSeconds);
        if (returnedCode === 'CONFIG_ERROR') {
          throw new AiClientError({
            code: 'CONFIG_ERROR',
            message: returnedMessage || 'AI generation service is not properly configured.',
            isRetryable: false,
            statusCode: 503,
            requestId: effectiveRequestId,
          });
        }
        throw new AiClientError({
          code: 'UPSTREAM_ERROR',
          message: returnedMessage || 'AI generation service is temporarily unavailable. Retrying...',
          isRetryable: true,
          statusCode: 503,
          requestId: effectiveRequestId,
        });
      }

      // HTTP 504 Gateway Timeout
      if (response.status === 504 || returnedCode === 'TIMEOUT') {
        recordAiRequest(model, 'error');
        recordAiDuration(model, durationSeconds);
        throw new AiClientError({
          code: 'TIMEOUT',
          message: returnedMessage || `AI generation timed out after ${timeoutMs / 1000} seconds.`,
          isRetryable: true,
          statusCode: 504,
          requestId: effectiveRequestId,
        });
      }

      // Default fallback for any other unexpected status
      recordAiRequest(model, 'error');
      recordAiDuration(model, durationSeconds);
      throw new AiClientError({
        code: 'UPSTREAM_ERROR',
        message: returnedMessage || `AI generation service returned HTTP ${response.status}.`,
        isRetryable: true,
        statusCode: response.status,
        requestId: effectiveRequestId,
      });
    }

    // HTTP 200 OK: Parse and validate JSON
    let parsedJson: unknown;
    try {
      parsedJson = await response.json();
    } catch (parseError) {
      recordAiRequest(model, 'malformed_output');
      recordAiDuration(model, durationSeconds);
      logger.error('ai_client_json_parse_failed', {
        requestId: effectiveRequestId,
        model,
        status: response.status,
        errorMessage: (parseError as Error).message,
      });
      throw new AiClientError({
        code: 'MALFORMED_AI_OUTPUT',
        message: 'The AI model output could not be parsed into notes format.',
        isRetryable: false,
        statusCode: response.status,
        requestId: effectiveRequestId,
        cause: parseError,
      });
    }

    const validation = generatedNotesSchema.safeParse(parsedJson);
    if (!validation.success) {
      recordAiRequest(model, 'malformed_output');
      recordAiDuration(model, durationSeconds);
      logger.error('ai_client_schema_validation_failed', {
        requestId: effectiveRequestId,
        model,
        status: response.status,
        errors: validation.error.format(),
      });
      throw new AiClientError({
        code: 'MALFORMED_AI_OUTPUT',
        message: 'The AI model output could not be parsed into notes format.',
        isRetryable: false,
        statusCode: response.status,
        requestId: effectiveRequestId,
        cause: validation.error,
      });
    }

    // Success metrics & span attributes
    recordAiRequest(model, 'success');
    recordAiDuration(model, durationSeconds);
    safeSpan.setAttribute('status', 'success');
    safeSpan.setStatus({ code: SpanStatusCode.OK });

    logger.info('ai_client_request_completed', {
      requestId,
      model,
      durationMs: Math.round(durationSeconds * 1000),
      keyConceptsCount: validation.data.keyConcepts.length,
      shorthandsCount: validation.data.shorthands.length,
    });

    return validation.data;
  };

  if (options?.span) {
    return await executeWithSpan(options.span);
  }

  return await withSpan(
    'fastapi.http_request',
    async (span) => {
      return await executeWithSpan(span);
    },
    {
      'http.request.method': 'POST',
      'http.route': '/api/v1/generate',
      model,
    }
  );
}
