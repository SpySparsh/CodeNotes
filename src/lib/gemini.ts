import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';

const apiKey = process.env.GEMINI_API_KEY || '';
const genAI = new GoogleGenerativeAI(apiKey);

export interface GeneratedNotes {
  overview: string;
  keyConcepts: string[];
  detailedNotes: string;
  shorthands: string[];
}

export async function generateNotes(transcript: string, videoTitle: string): Promise<GeneratedNotes> {
  if (!apiKey || apiKey === 'your_api_key_here') {
    throw new Error('Gemini API key is missing or invalid. Please check .env.local');
  }

  const model = genAI.getGenerativeModel({ 
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
  });

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
      console.error('Failed to parse Gemini output as JSON:', parseError);
      console.error('Raw Output:', responseText);
      throw new Error('AI returned malformed data.');
    }
  } catch (error: any) {
    console.error('Error generating notes with Gemini:', error);
    throw new Error(error.message || 'Failed to generate notes using AI.');
  }
}
