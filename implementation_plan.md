# CodeNotes AI — Implementation Plan

Build a local web app that takes a YouTube URL, fetches its transcript, and uses Gemini AI to generate structured study notes with code extraction.

## User Review Required

> [!IMPORTANT]
> **Gemini API Key**: You will need a `GEMINI_API_KEY` environment variable. The app will use Gemini 2.0 Flash (the latest stable flash model) via `@google/generativeai`. Please confirm you have a key, or I'll add a placeholder in `.env.local`.

> [!NOTE]  
> **Tailwind CSS version**: The user requested Tailwind CSS. I will use Tailwind CSS v4 (the default with latest Next.js/create-next-app). Shadcn/UI will be initialized via `npx shadcn@latest init`.

## Architecture

```
┌─────────────────────────────────────────────────┐
│                  Next.js App                     │
│  ┌──────────┐  ┌──────────┐  ┌───────────────┐ │
│  │ Landing   │  │ Notes    │  │ Library       │ │
│  │ Page (/)  │  │ (/notes) │  │ (/library)    │ │
│  └────┬──────┘  └────┬─────┘  └───────┬───────┘ │
│       │              │                │          │
│  ┌────▼──────────────▼────────────────▼───────┐ │
│  │            API Routes (/api)               │ │
│  │  POST /generate  GET /notes  GET /notes/id │ │
│  └────┬───────────────┬───────────────────────┘ │
│       │               │                         │
│  ┌────▼────┐   ┌──────▼─────┐   ┌────────────┐ │
│  │YouTube  │   │ Gemini AI  │   │  SQLite DB  │ │
│  │Transcript│  │ Pipeline   │   │ (local)     │ │
│  └─────────┘   └────────────┘   └────────────┘ │
└─────────────────────────────────────────────────┘
```

## Proposed Changes

### Project Scaffolding

#### [NEW] Project root (`d:\unstuckstudy`)

Scaffold via `npx -y create-next-app@latest ./ --ts --tailwind --eslint --app --src-dir --import-alias "@/*" --turbopack --yes`. Then install:
- `youtube-transcript` — fetch YouTube transcripts without API key
- `@google/generativeai` — Gemini AI SDK
- `better-sqlite3` + `@types/better-sqlite3` — local SQLite storage  
- `lucide-react` — icon library
- `react-markdown` + `remark-gfm` + `rehype-highlight` — render markdown notes with syntax highlighting

---

### Backend — Lib Utilities

#### [NEW] [transcript.ts](file:///d:/unstuckstudy/src/lib/transcript.ts)
- `fetchTranscript(url: string)` — Extract video ID from URL, call `youtube-transcript` to get timed transcript segments, join into full text
- `extractVideoMetadata(url: string)` — Parse video ID, title (from page scrape or oEmbed)

#### [NEW] [gemini.ts](file:///d:/unstuckstudy/src/lib/gemini.ts)
- `generateNotes(transcript: string, videoTitle: string)` — Send transcript to Gemini with a structured prompt that produces JSON with sections: `executiveSummary`, `technicalDeepDive`, `codeBlocks[]`, `keyTakeaways[]`
- **Code Extraction Logic**: The prompt explicitly instructs Gemini to detect any mention of functions, classes, variables, or specific syntax in the transcript and reconstruct accurate code blocks with language tags

#### [NEW] [db.ts](file:///d:/unstuckstudy/src/lib/db.ts)
- Initialize SQLite database at `./data/codenotes.db`
- `notes` table: `id`, `videoId`, `videoTitle`, `videoUrl`, `thumbnailUrl`, `executiveSummary`, `technicalDeepDive`, `codeBlocks (JSON)`, `keyTakeaways (JSON)`, `createdAt`
- CRUD: `saveNote()`, `getAllNotes()`, `getNoteById()`, `deleteNote()`

---

### Backend — API Routes

#### [NEW] [route.ts](file:///d:/unstuckstudy/src/app/api/generate/route.ts)
- `POST` — accepts `{ url }`, fetches transcript, calls Gemini, saves to DB, returns the note

#### [NEW] [route.ts](file:///d:/unstuckstudy/src/app/api/notes/route.ts)
- `GET` — returns all saved notes (summary view)

#### [NEW] [route.ts](file:///d:/unstuckstudy/src/app/api/notes/[id]/route.ts)
- `GET` — returns a single note by ID
- `DELETE` — deletes a note by ID

---

### Frontend — Pages

#### [MODIFY] [page.tsx](file:///d:/unstuckstudy/src/app/page.tsx)
- Landing page: Premium dark gradient background, centered hero section
- YouTube URL input with animated border glow on focus
- Submit button triggers `POST /api/generate`
- Loading state with pulsing skeleton animation

#### [NEW] [page.tsx](file:///d:/unstuckstudy/src/app/notes/[id]/page.tsx)
- Fetch note by ID from API
- Render structured sections: Executive Summary, Technical Deep Dive, Code Blocks (with copy button), Key Takeaways
- Use `react-markdown` with `rehype-highlight` for code syntax highlighting
- Sticky header with video title and back navigation

#### [NEW] [page.tsx](file:///d:/unstuckstudy/src/app/library/page.tsx)
- Grid/list of all saved notes with thumbnail, title, date
- Click to navigate to individual note
- Delete button with confirmation
- Empty state with illustration

---

### Frontend — Components

#### [NEW] [UrlInput.tsx](file:///d:/unstuckstudy/src/components/UrlInput.tsx)
- Animated input with YouTube icon, validation, submit handler

#### [NEW] [NoteCard.tsx](file:///d:/unstuckstudy/src/components/NoteCard.tsx)
- Card for library grid: thumbnail, title, date, preview text

#### [NEW] [CodeBlock.tsx](file:///d:/unstuckstudy/src/components/CodeBlock.tsx)
- Custom code block renderer with language label and "Copy to Clipboard" button
- Clipboard animation feedback (checkmark on success)

#### [NEW] [LoadingState.tsx](file:///d:/unstuckstudy/src/components/LoadingState.tsx)
- Full-screen loading overlay with animated progress messages

#### [NEW] [Navbar.tsx](file:///d:/unstuckstudy/src/components/Navbar.tsx)
- Top navigation: logo, links to Home and Library

---

### Styling

#### [MODIFY] [globals.css](file:///d:/unstuckstudy/src/app/globals.css)
- Dark mode color scheme (deep navy/charcoal backgrounds, cyan/purple accents)
- Google Font import (Inter/Geist)
- Custom scrollbar styling
- Glassmorphism utility classes
- Animation keyframes (glow, pulse, fade-in, slide-up)

---

## Verification Plan

### Automated (Browser Test via Antigravity)
1. Start dev server: `npm run dev` in `d:\unstuckstudy`
2. Open `http://localhost:3000` in browser
3. Verify landing page renders with dark theme, URL input, and navigation
4. Enter a YouTube coding tutorial URL (e.g., `https://www.youtube.com/watch?v=dQw4w9WgXcQ` or a real tutorial)
5. Submit and verify loading state appears
6. After generation, verify note page renders with all sections
7. Navigate to `/library` and verify the note appears in the list
8. Test copy-to-clipboard button on a code block

### Manual Verification (User)
- Visually inspect UI quality and dark mode aesthetics
- Confirm generated notes are accurate and code blocks are properly formatted
- Test with different YouTube URLs (coding tutorials, lectures, etc.)
