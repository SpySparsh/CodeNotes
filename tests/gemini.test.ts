import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registry } from '@/lib/metrics';

const { generateContentMock, getGenerativeModelMock } = vi.hoisted(() => {
  const generateContentMock = vi.fn();
  const getGenerativeModelMock = vi.fn(() => ({
    generateContent: generateContentMock,
  }));
  return { generateContentMock, getGenerativeModelMock };
});

vi.mock('@google/generative-ai', () => {
  return {
    GoogleGenerativeAI: class {
      getGenerativeModel = getGenerativeModelMock;
    },
    SchemaType: {
      OBJECT: 'OBJECT',
      STRING: 'STRING',
      ARRAY: 'ARRAY',
    },
  };
});

import { generateNotes, GEMINI_MODEL } from '@/lib/gemini';

describe('Gemini AI Inference & Metrics Layer', () => {
  const mockTranscript = 'In this tutorial we learn TypeScript interfaces and generics.';
  const mockTitle = 'TypeScript Generics Tutorial';

  beforeEach(() => {
    vi.clearAllMocks();
    registry.resetMetrics();
  });

  it('generates structured notes and records success metrics and duration on valid AI JSON response', async () => {
    const validNotes = {
      overview: 'Overview of TypeScript generics and type constraints.',
      keyConcepts: ['Generics', 'Type Constraints', 'Interfaces'],
      detailedNotes: '# Detailed Notes\n\n```typescript\nfunction identity<T>(arg: T): T { return arg; }\n```',
      shorthands: ['Use extends for constraints'],
    };

    generateContentMock.mockResolvedValueOnce({
      response: {
        text: () => JSON.stringify(validNotes),
      },
    });

    const result = await generateNotes(mockTranscript, mockTitle);

    expect(result).toEqual(validNotes);

    const metricsText = await registry.metrics();
    expect(metricsText).toContain(`codenotes_ai_requests_total{model="${GEMINI_MODEL}",status="success"} 1`);
    expect(metricsText).toContain(`codenotes_ai_duration_seconds_count{model="${GEMINI_MODEL}"} 1`);
  });

  it('strips markdown code fences (```json) and records success metrics', async () => {
    const validNotes = {
      overview: 'Clean markdown fenced JSON response.',
      keyConcepts: ['Concept 1'],
      detailedNotes: '# Markdown notes',
      shorthands: ['Tip 1'],
    };

    generateContentMock.mockResolvedValueOnce({
      response: {
        text: () => `\`\`\`json\n${JSON.stringify(validNotes)}\n\`\`\``,
      },
    });

    const result = await generateNotes(mockTranscript, mockTitle);

    expect(result).toEqual(validNotes);

    const metricsText = await registry.metrics();
    expect(metricsText).toContain(`codenotes_ai_requests_total{model="${GEMINI_MODEL}",status="success"} 1`);
    expect(metricsText).toContain(`codenotes_ai_duration_seconds_count{model="${GEMINI_MODEL}"} 1`);
  });

  it('records malformed_output and duration when Gemini returns unparseable JSON', async () => {
    generateContentMock.mockResolvedValueOnce({
      response: {
        text: () => 'NOT_VALID_JSON_CONTENT',
      },
    });

    await expect(generateNotes(mockTranscript, mockTitle)).rejects.toThrow('AI returned malformed data.');

    const metricsText = await registry.metrics();
    expect(metricsText).toContain(`codenotes_ai_requests_total{model="${GEMINI_MODEL}",status="malformed_output"} 1`);
    expect(metricsText).not.toContain(`codenotes_ai_requests_total{model="${GEMINI_MODEL}",status="error"}`);
    expect(metricsText).toContain(`codenotes_ai_duration_seconds_count{model="${GEMINI_MODEL}"} 1`);
  });

  it('records error and duration when Gemini API call throws a network or server error', async () => {
    generateContentMock.mockRejectedValueOnce(
      new Error('[GoogleGenerativeAI Error]: [503 Service Unavailable]')
    );

    await expect(generateNotes(mockTranscript, mockTitle)).rejects.toThrow(
      '[GoogleGenerativeAI Error]: [503 Service Unavailable]'
    );

    const metricsText = await registry.metrics();
    expect(metricsText).toContain(`codenotes_ai_requests_total{model="${GEMINI_MODEL}",status="error"} 1`);
    expect(metricsText).not.toContain(`codenotes_ai_requests_total{model="${GEMINI_MODEL}",status="success"}`);
    expect(metricsText).toContain(`codenotes_ai_duration_seconds_count{model="${GEMINI_MODEL}"} 1`);
  });

  it('records error and duration when Gemini times out', async () => {
    const timeoutError = new Error('The operation was aborted due to timeout');
    timeoutError.name = 'TimeoutError';
    generateContentMock.mockRejectedValueOnce(timeoutError);

    await expect(generateNotes(mockTranscript, mockTitle)).rejects.toThrow(
      'AI generation timed out after 75 seconds.'
    );

    const metricsText = await registry.metrics();
    expect(metricsText).toContain(`codenotes_ai_requests_total{model="${GEMINI_MODEL}",status="error"} 1`);
    expect(metricsText).toContain(`codenotes_ai_duration_seconds_count{model="${GEMINI_MODEL}"} 1`);
  });
});
