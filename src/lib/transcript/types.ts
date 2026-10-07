export type TranscriptErrorCode =
  | 'TRANSCRIPT_UNAVAILABLE'
  | 'TRANSCRIPT_PROVIDER_AUTH_ERROR'
  | 'TRANSCRIPT_PROVIDER_RATE_LIMITED'
  | 'TRANSCRIPT_PROVIDER_QUOTA_EXCEEDED'
  | 'TRANSCRIPT_PROVIDER_UNAVAILABLE'
  | 'TRANSCRIPT_INVALID_RESPONSE'
  | 'INVALID_URL';

export class TranscriptError extends Error {
  readonly code: TranscriptErrorCode;
  readonly isRetryable: boolean;
  readonly provider?: 'supadata' | 'youtube-transcript';

  constructor(
    code: TranscriptErrorCode,
    message: string,
    isRetryable = false,
    provider?: 'supadata' | 'youtube-transcript'
  ) {
    super(message);
    this.name = 'TranscriptError';
    this.code = code;
    this.isRetryable = isRetryable;
    this.provider = provider;
  }
}

export type TranscriptProviderName = 'supadata' | 'youtube-transcript';

export interface TranscriptResult {
  text: string;
  videoId: string;
  provider: TranscriptProviderName;
}

export interface VideoMetadata {
  videoId: string;
  title: string;
}
