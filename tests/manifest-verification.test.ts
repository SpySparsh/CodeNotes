import { describe, it, expect } from 'vitest';
import {
  planChunkManifest,
  computeCanonicalManifestHash,
  type ChunkManifest,
} from '@/lib/chunk-planner';

describe('Canonical Manifest Hash & Determinism Verification', () => {
  const sampleTranscript = 'Paragraph one of transcript text.\n\nParagraph two with more details.\n\nParagraph three concluding.';
  const videoId = 'dQw4w9WgXcQ';

  it('produces identical canonical hashes for identical planned manifests', () => {
    const manifest1 = planChunkManifest(videoId, sampleTranscript);
    const manifest2 = planChunkManifest(videoId, sampleTranscript);

    const hash1 = computeCanonicalManifestHash(manifest1);
    const hash2 = computeCanonicalManifestHash(manifest2);

    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64);
  });

  it('produces identical hash regardless of chunk array order', () => {
    const manifest = planChunkManifest(videoId, sampleTranscript);
    const reversedManifest: ChunkManifest = {
      ...manifest,
      chunks: [...manifest.chunks].reverse(),
    };

    const hashOriginal = computeCanonicalManifestHash(manifest);
    const hashReversed = computeCanonicalManifestHash(reversedManifest);

    expect(hashOriginal).toBe(hashReversed);
  });

  it('produces different hash when chunk contents or metadata differ', () => {
    const manifest1 = planChunkManifest(videoId, sampleTranscript);
    const modifiedManifest: ChunkManifest = {
      ...manifest1,
      totalChunks: manifest1.totalChunks + 1,
    };

    const hash1 = computeCanonicalManifestHash(manifest1);
    const hash2 = computeCanonicalManifestHash(modifiedManifest);

    expect(hash1).not.toBe(hash2);
  });

  it('rejects invalid manifest input', () => {
    expect(() => computeCanonicalManifestHash(null as any)).toThrow();
    expect(() => computeCanonicalManifestHash({} as any)).toThrow();
  });
});
