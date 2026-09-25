import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import { logger } from '@/lib/logger';

const apiKey = process.env.GEMINI_API_KEY || '';
const genAI = new GoogleGenerativeAI(apiKey);

export interface GeneratedNotes {
  overview: string;
  keyConcepts: string[];
  detailedNotes: string;
  shorthands: string[];
}

export const GEMINI_TIMEOUT_MS = 75000;

export async function generateNotes(transcript: string, videoTitle: string): Promise<GeneratedNotes> {
  if (!apiKey || apiKey === 'your_api_key_here') {
    throw new Error('Gemini API key is missing or invalid. Please check .env.local');
  }

  const model = genAI.getGenerativeModel(
    {
      model: 'gemini-2.5-flash',
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: SchemaType.OBJECT,
          properties: {
            overview: {
              type: SchemaType.STRING,
              description: "A compelling overview of the video's purpose (2-3 sentences)."
            },
            keyConcepts: {
              type: SchemaType.ARRAY,
              items: { type: SchemaType.STRING },
              description: "List of key concepts"
            },
            detailedNotes: {
              type: SchemaType.STRING,
              description: "The exhaustive, comprehensive markdown string containing all the Detailed Topics with contextual inline code blocks and Markdown Comparison Tables."
            },
            shorthands: {
              type: SchemaType.ARRAY,
              items: { type: SchemaType.STRING },
              description: "List of shorthands or quick tips"
            }
          },
          required: ["overview", "keyConcepts", "detailedNotes", "shorthands"]
        }
      }
    },
    {
      timeout: GEMINI_TIMEOUT_MS,
    }
  );

  const prompt = `
You are a Senior Full-Stack Engineer and Technical Content Architect.
I have a transcript from a YouTube programming tutorial titled "${videoTitle}". 
Your objective is to generate premium, highly structured technical study notes based on this content.

# Functional Requirements
1. **Structure First:** Your output must adhere to the following logical structure:
   - Overview
   - Key Concepts List
   - Detailed Topics (the main content)
   - Comparison Tables (where applicable)
   - Shorthands/Quick Tips

2. **Contextual Code Mapping:** Do NOT clump code blocks at the end. When you process a theory block or topic within the 'detailedNotes' markdown, you MUST immediately locate and insert the syntactically correct code block exactly where it belongs conceptually. All code must reside inline within the appropriate detailed topic sections using standard markdown fences (e.g., \`\`\`typescript).

3. **Comparison Tables:** Whenever the transcript compares two or more topics, concepts, or tools (e.g., if-else vs switch, React vs Vue), you MUST generate a Markdown comparison table to highlight differences (Performance, Use Case, Readability, etc.) inline within the 'detailedNotes' markdown string.

Return the result strictly as a JSON object matching this schema:
{
  "overview": "A compelling overview of the video's purpose (2-3 sentences).",
  "keyConcepts": ["Concept 1", "Concept 2", "Concept 3"],
  "detailedNotes": "The exhaustive, comprehensive markdown string containing all the Detailed Topics with contextual inline \`\`\` code blocks and Markdown Comparison Tables.",
  "shorthands": ["Quick tip 1", "Gotcha 2", "Best practice 3"]
}

Here is the transcript:
==================
${transcript}
==================
`;

  try {
    const result = await model.generateContent(prompt);
    const responseText = result.response.text();
    
    let cleanedText = responseText;
    // Just in case the model ignores the mimeType and wraps in markdown anyway
    if (cleanedText.startsWith('```json')) {
       cleanedText = cleanedText.replace(/^\`\`\`json\n?/, '').replace(/\n?\`\`\`$/, '').trim();
    }
    
    try {
      const parsedData = JSON.parse(cleanedText) as GeneratedNotes;
      return parsedData;
    } catch (parseError) {
      logger.error('gemini_json_parse_failed', {
        errorMessage: String(parseError),
        rawOutputPreview: cleanedText.slice(0, 200),
      });
      throw new Error('AI returned malformed data.');
    }
  } catch (error: any) {
    const isTimeout =
      error.name === 'AbortError' ||
      error.name === 'TimeoutError' ||
      error.message?.includes('timeout') ||
      error.message?.includes('aborted');

    if (isTimeout) {
      logger.warn('gemini_timeout', { timeoutMs: GEMINI_TIMEOUT_MS });
      throw new Error(`AI generation timed out after ${GEMINI_TIMEOUT_MS / 1000} seconds.`);
    }

    // Route handler (generate/route.ts) already logs this error with errorMessage + errorStack.
    throw new Error(error.message || 'Failed to generate notes using AI.');
  }
}

export async function generateNotesFromVideoUrl(videoUrl: string, videoTitle: string): Promise<GeneratedNotes> {
  if (!apiKey || apiKey === 'your_api_key_here') {
    throw new Error('Gemini API key is missing or invalid. Please check .env.local');
  }

  const model = genAI.getGenerativeModel(
    {
      model: 'gemini-2.5-flash',
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: SchemaType.OBJECT,
          properties: {
            overview: {
              type: SchemaType.STRING,
              description: "A compelling overview of the video's purpose (2-3 sentences)."
            },
            keyConcepts: {
              type: SchemaType.ARRAY,
              items: { type: SchemaType.STRING },
              description: "List of key concepts"
            },
            detailedNotes: {
              type: SchemaType.STRING,
              description: "The exhaustive, comprehensive markdown string containing all the Detailed Topics with contextual inline code blocks and Markdown Comparison Tables."
            },
            shorthands: {
              type: SchemaType.ARRAY,
              items: { type: SchemaType.STRING },
              description: "List of shorthands or quick tips"
            }
          },
          required: ["overview", "keyConcepts", "detailedNotes", "shorthands"]
        }
      }
    },
    {
      timeout: GEMINI_TIMEOUT_MS,
    }
  );

  const prompt = `
You are a Senior Full-Stack Engineer and Technical Content Architect.
You are analyzing a YouTube programming tutorial titled "${videoTitle}".
Your objective is to generate premium, highly structured technical study notes based on this video.

# Functional Requirements
1. **Structure First:** Your output must adhere to the following logical structure:
   - Overview
   - Key Concepts List
   - Detailed Topics (the main content)
   - Comparison Tables (where applicable)
   - Shorthands/Quick Tips

2. **Contextual Code Mapping:** Do NOT clump code blocks at the end. When you process a theory block or topic within the 'detailedNotes' markdown, you MUST immediately locate and insert the syntactically correct code block exactly where it belongs conceptually. All code must reside inline within the appropriate detailed topic sections using standard markdown fences (e.g., \`\`\`typescript).

3. **Comparison Tables:** Whenever the video compares two or more topics, concepts, or tools (e.g., if-else vs switch, React vs Vue), you MUST generate a Markdown comparison table to highlight differences (Performance, Use Case, Readability, etc.) inline within the 'detailedNotes' markdown string.

Return the result strictly as a JSON object matching this schema:
{
  "overview": "A compelling overview of the video's purpose (2-3 sentences).",
  "keyConcepts": ["Concept 1", "Concept 2", "Concept 3"],
  "detailedNotes": "The exhaustive, comprehensive markdown string containing all the Detailed Topics with contextual inline \`\`\` code blocks and Markdown Comparison Tables.",
  "shorthands": ["Quick tip 1", "Gotcha 2", "Best practice 3"]
}
`;

  try {
    const result = await model.generateContent([
      {
        fileData: {
          fileUri: videoUrl,
          mimeType: "video/*"
        }
      },
      prompt
    ]);
    const responseText = result.response.text();

    let cleanedText = responseText;
    if (cleanedText.startsWith('```json')) {
       cleanedText = cleanedText.replace(/^\`\`\`json\n?/, '').replace(/\n?\`\`\`$/, '').trim();
    }

    try {
      const parsedData = JSON.parse(cleanedText) as GeneratedNotes;
      return parsedData;
    } catch (parseError) {
      logger.error('gemini_json_parse_failed', {
        errorMessage: String(parseError),
        rawOutputPreview: cleanedText.slice(0, 200),
      });
      throw new Error('AI returned malformed data.');
    }
  } catch (error: any) {
    const isTimeout =
      error.name === 'AbortError' ||
      error.name === 'TimeoutError' ||
      error.message?.includes('timeout') ||
      error.message?.includes('aborted');

    if (isTimeout) {
      logger.warn('gemini_timeout', { timeoutMs: GEMINI_TIMEOUT_MS });
      throw new Error(`AI generation timed out after ${GEMINI_TIMEOUT_MS / 1000} seconds.`);
    }

    throw new Error(error.message || 'Failed to generate notes using AI.');
  }
}
