# codenotes.ai

[![Next.js](https://img.shields.io/badge/Next.js-16.2.1-black?style=for-the-badge&logo=next.js)](https://nextjs.org/)
[![React](https://img.shields.io/badge/React-19.2.4-blue?style=for-the-badge&logo=react)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue?style=for-the-badge&logo=typescript)](https://www.typescriptlang.org/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-v4-38B2AC?style=for-the-badge&logo=tailwind-css)](https://tailwindcss.com/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-8.20-336791?style=for-the-badge&logo=postgresql)](https://www.postgresql.org/)
[![Gemini](https://img.shields.io/badge/Gemini_2.5_Flash-Google_AI-orange?style=for-the-badge&logo=google)](https://ai.google.dev/)

> **Production Deployment:** `[INSERT LIVE PROD URL HERE]`  
> **Repository:** `[INSERT REPOSITORY URL HERE]`

---

## 1. Executive Summary & Core Objective

### What does this project do?
**codenotes.ai** is an AI-powered educational assistant and technical study companion. It transforms video-based coding tutorials from YouTube into structured, interactive, and easily scannable technical study notes. Given a YouTube video URL, the application automatically extracts the video transcript and metadata, runs it through Google's Gemini 2.5 Flash model with a schema-enforced prompt, extracts inline code snippets and comparison tables, and persists the generated notes into a PostgreSQL database for persistent access in a user library.

### Who is the end user?
- **Software Engineers & Developers** learning new frameworks, libraries, or architectures from conference talks and tutorials without wanting to pause every 15 seconds to copy code.
- **Computer Science Students & Bootcamp Learners** who need organized, structured notes, summaries, and syntax reference sheets for exam prep or reference.
- **Technical Writers & Instructors** seeking to convert video walkthroughs and lectures into clean markdown summaries with contextual code blocks.

### What core business problem does it solve?
Video is one of the richest mediums for programming education, but it is notoriously low-bandwidth for reference and retention. Developers waste excessive time repeatedly pausing, rewinding, squinting at terminal windows, and manually transcribing code snippets into notes. Furthermore, videos are unsearchable and non-indexable for rapid lookup. **codenotes.ai** bridges the gap between passive video watching and active technical reference by automating code extraction, theoretical summaries, and architectural comparison tables into structured markdown.

---

## 2. Tech Stack & Dependencies

### Frontend
- **Framework:** [Next.js](https://nextjs.org/) `16.2.1` (App Router, React Server & Client Components)
- **Core Library:** [React](https://react.dev/) `19.2.4` & [React DOM](https://react.dev/) `19.2.4`
- **Styling & Design System:**
  - [Tailwind CSS](https://tailwindcss.com/) `v4.0.0` (using `@tailwindcss/postcss` and CSS variables theme tokens)
  - `tailwindcss-animate` for micro-interactions and transitions
  - Custom glassmorphic typography and light/dark theme variables (`src/app/globals.css`)
- **Iconography:** [Lucide React](https://lucide.dev/) `^0.475.0`
- **Markdown & Code Rendering:**
  - `react-markdown` (`^9.0.1`) with `remark-gfm` (`^4.0.0`) for table and GFM support
  - `react-syntax-highlighter` (`^15.6.1`) with `prism` theme for syntax highlighting
  - `rehype-highlight` (`^7.0.0`)
- **State Management:**
  - React Built-in Hooks (`useState`, `useEffect`, `useRouter`, `useParams`)
  - Optimistic UI updates for immediate user feedback on card actions (e.g., deletion)

### Backend
- **Language:** TypeScript (`^5.0.0`)
- **Framework:** Next.js Route Handlers (`src/app/api/...`) running on Node.js runtime
- **Runtime Environment:** Node.js (v20+ LTS recommended)
- **Database Driver:** `pg` (`^8.20.0`) with `@types/pg` (`^8.20.0`) utilizing connection pooling (`pg.Pool`) and native SSL support (`rejectUnauthorized: false` for managed cloud DBs)
- **Environment Management:** `dotenv` (`^17.3.1`)
- **Crypto & ID Generation:** Native Node.js `crypto.randomUUID()` for RFC 4122 UUID primary keys

### Database & Storage
- **Database Type:** [PostgreSQL](https://www.postgresql.org/) (Compatible with [Supabase](https://supabase.com/), [Neon](https://neon.tech/), AWS RDS, or local Postgres)
- **ORM / Query Layer:** Direct parameterized SQL queries via `pg.Pool` (`src/lib/db.ts`) for zero-overhead, sub-millisecond query execution and native array handling (`TEXT[]`)
- **Media Storage / CDN:** YouTube's native image CDN (`https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`) for zero-storage thumbnail serving

### Infrastructure / DevOps
- **Bundler / Compiler:** Next.js Turbopack (`turbopack: { root: __dirname }` in `next.config.mjs`)
- **Hosting / Platform:** [Vercel](https://vercel.com/) (Production-ready with SSL database parameters)
- **Linting & Code Quality:** ESLint `^9.0.0` with `eslint-config-next` `16.2.1`
- **CI/CD:** Automated builds and previews via Vercel GitHub integration

### Third-Party Services & APIs
- **Google Gemini AI:** `@google/generative-ai` (`^0.24.0`) targeting `gemini-2.5-flash` with strict structured JSON schema generation (`responseMimeType: "application/json"`, `responseSchema: SchemaType.OBJECT`).
- **YouTube Transcript Service:** `youtube-transcript` (`^1.2.1`) for direct caption stream extraction without requiring YouTube Data API v3 quotas or OAuth credentials.
- **NoEmbed API:** `https://noembed.com/embed?url=${url}` for lightweight oEmbed video title discovery.

---

## 3. High-Level Architecture & Project Structure

### Component Communication & Data Flow

```
[ User Browser ]
       │
       ▼ (1. Paste YouTube URL & Submit)
[ Next.js Client Page: / ] (UrlInput.tsx)
       │
       ▼ (2. POST /api/generate { url })
[ API Route Handler: /api/generate ]
       │
       ├───► [ 3. transcript.ts: fetchTranscript(url) ]
       │          └─► Calls `youtube-transcript` -> Extracts captions text & video ID
       │
       ├───► [ 4. transcript.ts: extractVideoTitle(url) ]
       │          └─► Calls `noembed.com` -> Retrieves clean title
       │
       ├───► [ 5. gemini.ts: generateNotes(text, title) ]
       │          └─► Dispatches prompt to Gemini 2.5 Flash with strict JSON Schema
       │          └─► Returns: { overview, keyConcepts, detailedNotes, shorthands }
       │
       ├───► [ 6. db.ts: query(INSERT INTO notes ...) ]
       │          └─► Persists to PostgreSQL via `pg.Pool`
       │
       ▼ (7. Return { success: true, noteId })
[ Client Redirects to /notes/[id] ]
       │
       ▼ (8. GET /api/notes/[id])
[ View Rendered Note ] (Markdown, Syntax Highlighted Code, Quick Tips)
```

### Directory Map

```
unstuckstudy/
├── .env.example              # Template for required environment variables
├── .env.local                # Local environment secrets (ignored by Git)
├── .gitignore                # Git ignore configuration
├── next.config.mjs           # Next.js configuration (Turbopack root config)
├── package.json              # Project dependencies and operational scripts
├── postcss.config.mjs        # PostCSS configuration for Tailwind CSS v4
├── tsconfig.json             # TypeScript compiler settings & alias mapping (@/*)
├── scripts/
│   └── migrate-json-to-pg.js # Migration utility script for creating tables & importing JSON data
├── src/
│   ├── app/                  # Next.js App Router (pages and API endpoints)
│   │   ├── api/
│   │   │   ├── generate/     # POST: Core AI pipeline orchestrator
│   │   │   │   └── route.ts
│   │   │   └── notes/        # REST endpoints for notes collection & items
│   │   │       ├── route.ts  # GET: Retrieve all notes sorted by created_at DESC
│   │   │       └── [id]/
│   │   │           └── route.ts # GET: Single note by ID; DELETE: Delete note by ID
│   │   ├── globals.css       # Tailwind v4 directives, custom styling, animations
│   │   ├── layout.tsx        # Root HTML wrapper with Navbar and global fonts
│   │   ├── page.tsx          # Landing / Hero page with YouTube URL input
│   │   ├── library/          # User notes library
│   │   │   └── page.tsx      # Grid view of all saved study notes
│   │   └── notes/[id]/       # Note detail reader
│   │       └── page.tsx      # Comprehensive note page with Markdown & CodeBlock renderer
│   ├── components/           # Reusable React UI components
│   │   ├── CodeBlock.tsx     # Syntax highlighter with copy-to-clipboard functionality
│   │   ├── LoadingState.tsx  # Dynamic multi-ring spinner with status descriptions
│   │   ├── Navbar.tsx        # Top navigation header with active routing links
│   │   ├── NoteCard.tsx      # Library item card with thumbnail, preview & delete action
│   │   └── UrlInput.tsx      # YouTube input form with validation & submission state
│   └── lib/                  # Server-side business logic and utilities
│       ├── db.ts             # PostgreSQL pool setup, query wrapper, and Note interface
│       ├── gemini.ts         # Google Generative AI client, prompt engineering, and schema
│       └── transcript.ts     # YouTube transcript extractor and oEmbed metadata parser
```

---

## 4. Environment Variables & Configuration

Create a `.env.local` file in the root directory by copying the provided `.env.example`:

```bash
cp .env.example .env.local
```

### Required Configuration Keys

| Variable | Type | Description | Example / Fallback |
| :--- | :--- | :--- | :--- |
| `GEMINI_API_KEY` | String | Google AI Studio Gemini API Key | `AIzaSy...` |
| `DATABASE_URL` | String | PostgreSQL Connection URI with credentials | `postgresql://user:password@host:port/database?sslmode=require` |

> **Security Notice:** Never commit `.env.local` to version control. The repository's `.gitignore` explicitly blocks `.env*.local`.

---

## 5. Database Schema & Data Models

The database uses PostgreSQL with a single primary table named `notes`.

### DDL (Data Definition Language)

```sql
CREATE TABLE IF NOT EXISTS notes (
  id UUID PRIMARY KEY,
  video_id VARCHAR(255) NOT NULL,
  video_title TEXT NOT NULL,
  video_url TEXT NOT NULL,
  thumbnail_url TEXT,
  overview TEXT,
  key_concepts TEXT[],
  detailed_notes TEXT,
  shorthands TEXT[],
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
```

### TypeScript Data Interface (`src/lib/db.ts`)

```typescript
export interface Note {
  id: string;
  videoId: string;
  videoTitle: string;
  videoUrl: string;
  thumbnailUrl?: string;
  overview: string;
  keyConcepts: string[];
  detailedNotes: string;
  shorthands: string[];
  createdAt?: string;
}
```

### Field Descriptions
- `id` (`UUID`): Primary key generated via `crypto.randomUUID()`.
- `video_id` (`VARCHAR(255)`): Extracted 11-character YouTube video identifier.
- `video_title` (`TEXT`): Human-readable title fetched via NoEmbed API.
- `video_url` (`TEXT`): Full canonical YouTube URL submitted by the user.
- `thumbnail_url` (`TEXT`): YouTube CDN URL (`maxresdefault.jpg`) for video preview.
- `overview` (`TEXT`): 2–3 sentence executive summary generated by Gemini.
- `key_concepts` (`TEXT[]`): Array of strings summarizing major topical concepts.
- `detailed_notes` (`TEXT`): Comprehensive markdown content containing inline code blocks (```` ```language ````) and markdown comparison tables.
- `shorthands` (`TEXT[]`): Array of quick tips, gotchas, or best-practice pointers.
- `created_at` (`TIMESTAMPTZ`): Record insertion timestamp with time zone.

---

## 6. API Reference

All API routes are located in `src/app/api/` and follow Next.js App Router conventions.

### 1. Generate Study Notes
- **Endpoint:** `POST /api/generate`
- **Description:** Consumes a YouTube URL, retrieves transcript, prompts Gemini 2.5 Flash, saves to DB, and returns the generated note ID.
- **Request Headers:** `Content-Type: application/json`
- **Request Body:**
  ```json
  {
    "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
  }
  ```
- **Responses:**
  - `200 OK`:
    ```json
    {
      "success": true,
      "noteId": "3b61fa1c-1c52-475a-a384-1845fd7fcece"
    }
    ```
  - `400 Bad Request`: `{"error": "YouTube URL is required"}`
  - `500 Internal Server Error`: `{"error": "Failed to fetch video transcript..."}`

---

### 2. List All Notes
- **Endpoint:** `GET /api/notes`
- **Description:** Returns all saved notes sorted chronologically descending (`created_at DESC`).
- **Response:**
  - `200 OK`:
    ```json
    {
      "success": true,
      "notes": [
        {
          "id": "3b61fa1c-1c52-475a-a384-1845fd7fcece",
          "videoId": "dQw4w9WgXcQ",
          "videoTitle": "Advanced TypeScript Patterns",
          "videoUrl": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
          "thumbnailUrl": "https://img.youtube.com/vi/dQw4w9WgXcQ/maxresdefault.jpg",
          "overview": "An exhaustive breakdown of conditional types and mapped types.",
          "keyConcepts": ["Conditional Types", "Template Literal Types"],
          "detailedNotes": "## 1. Conditional Types...",
          "shorthands": ["Use infer for unwrapping Promise types"],
          "createdAt": "2026-03-28T19:30:00.000Z"
        }
      ]
    }
    ```

---

### 3. Get Note By ID
- **Endpoint:** `GET /api/notes/[id]`
- **Description:** Retrieves full note data by UUID.
- **URL Parameters:** `id` (UUID string)
- **Responses:**
  - `200 OK`: `{"success": true, "note": { ... }}`
  - `404 Not Found`: `{"error": "Note not found"}`
  - `500 Internal Server Error`: `{"error": "Failed to fetch the note"}`

---

### 4. Delete Note By ID
- **Endpoint:** `DELETE /api/notes/[id]`
- **Description:** Deletes a note by its UUID.
- **URL Parameters:** `id` (UUID string)
- **Responses:**
  - `200 OK`: `{"success": true}`
  - `500 Internal Server Error`: `{"error": "Failed to delete the note"}`

---

## 7. Core AI Pipeline & Prompt Engineering

The AI generation engine resides in [`src/lib/gemini.ts`](src/lib/gemini.ts).

### Model Configuration
- **Model:** `gemini-2.5-flash`
- **Output Format:** Strict JSON Schema (`responseMimeType: "application/json"`)
- **Schema Validation:** Configured via `@google/generative-ai` `SchemaType.OBJECT` enforcing:
  - `overview`: `STRING`
  - `keyConcepts`: `ARRAY` of `STRING`
  - `detailedNotes`: `STRING` (containing markdown, inline code fences, and comparison tables)
  - `shorthands`: `ARRAY` of `STRING`

### Prompt Architectural Constraints
The prompt explicitly enforces three strict rules on the LLM:
1. **Structure First:** Overview $\rightarrow$ Key Concepts $\rightarrow$ Detailed Topics $\rightarrow$ Comparison Tables $\rightarrow$ Shorthands.
2. **Contextual Code Mapping:** Code snippets must **never** be lumped at the end of the document. Whenever a theoretical block discusses an implementation, the accurate code block must be embedded inline using standard markdown fences (e.g. ```` ```typescript ````).
3. **Comparison Tables:** Whenever alternative solutions, patterns, or tools are contrasted (e.g., `let` vs `const`, SQL vs NoSQL, Server vs Client components), the model must construct a clean Markdown comparison table.

---

## 8. Local Setup & Getting Started

### Prerequisites
- **Node.js:** v20.x or higher installed
- **Package Manager:** `npm` (v10+), `pnpm`, or `yarn`
- **PostgreSQL Database:** Running locally on port `5432` or accessible via cloud provider (e.g. Supabase, Neon)
- **Google Gemini API Key:** Accessible from [Google AI Studio](https://aistudio.google.com/)

### Step-by-Step Installation

1. **Clone the repository:**
   ```bash
   git clone [INSERT REPOSITORY URL HERE]
   cd unstuckstudy
   ```

2. **Install project dependencies:**
   ```bash
   npm install
   ```

3. **Configure Environment Variables:**
   ```bash
   cp .env.example .env.local
   ```
   Edit `.env.local` and provide your actual credentials:
   ```env
   GEMINI_API_KEY=your_gemini_api_key_here
   DATABASE_URL=postgresql://postgres:your_password@localhost:5432/codenotes
   ```

4. **Initialize Database Schema:**
   Run the migration script to verify connectivity and create the `notes` table:
   ```bash
   node scripts/migrate-json-to-pg.js
   ```

5. **Start Development Server:**
   ```bash
   npm run dev
   ```

6. **Open in Browser:**
   Navigate to [http://localhost:3000](http://localhost:3000).

---

## 9. Database Migrations & Legacy Data

The project includes an automated database initialization script at [`scripts/migrate-json-to-pg.js`](scripts/migrate-json-to-pg.js):

- **Automatic Schema Creation:** Runs `CREATE TABLE IF NOT EXISTS notes (...)` with all necessary column types and constraints.
- **Legacy Migration Support:** Checks for the presence of `data/codenotes.json`. If an existing JSON dataset exists from previous versions of the app, it iterates through notes and imports them into Postgres without creating duplicate primary keys.
- **Execution:**
  ```bash
  node scripts/migrate-json-to-pg.js
  ```

---

## 10. Deployment & Hosting (Vercel & Supabase)

The application is architected for zero-configuration deployment on **Vercel** combined with a **Supabase** or **Neon** PostgreSQL database.

### 1. PostgreSQL (Supabase / Neon)
1. Create a project on [Supabase](https://supabase.com).
2. Copy the Connection String URI from **Project Settings $\rightarrow$ Database $\rightarrow$ Connection string (URI)**.
3. Ensure SSL connection is permitted (the connection pool in `src/lib/db.ts` is configured with `ssl: { rejectUnauthorized: false }` for cloud compatibility).

### 2. Vercel Deployment
1. Import the repository into your Vercel Dashboard.
2. Under **Project Settings $\rightarrow$ Environment Variables**, configure:
   - `GEMINI_API_KEY`: Your Google AI Studio API key.
   - `DATABASE_URL`: Your Supabase/Neon PostgreSQL connection URI.
3. Click **Deploy**. Vercel will run `npm run build` using Next.js Turbopack.

---

## 11. Known Caveats, Edge Cases & Troubleshooting

### 1. YouTube Videos Without Captions
- **Behavior:** If a video does not have user-submitted or auto-generated English captions enabled, `youtube-transcript` throws an error.
- **Handling:** The API catches this error in `src/lib/transcript.ts` and returns a descriptive error: `"Failed to fetch video transcript. The video might not have captions enabled."`
- **Mitigation:** Advise users to test with videos having closed captioning (CC) enabled.

### 2. PostgreSQL Connection Pooling on Serverless
- **Behavior:** Serverless edge or lambda functions can spawn high numbers of transient database connections.
- **Mitigation:** The application leverages `pg.Pool`. When scaling to high concurrency on Vercel, connect via a connection pooler like **Supabase Transaction Pooler (port 6543)** or **Prisma Accelerate / PgBouncer**.

### 3. Large Transcripts / Context Limits
- **Behavior:** Very long videos (e.g. 5+ hour streams) have massive transcript text lengths.
- **Mitigation:** Gemini 2.5 Flash supports a 1M+ token context window, comfortably handling extended transcripts without truncation.

---

## 12. Future Roadmap

- [ ] **User Authentication:** Support user logins via Supabase Auth / NextAuth / Clerk to isolate notes per user account.
- [ ] **Export Options:** One-click export to Markdown (`.md`), PDF, and Notion.
- [ ] **Timestamp Deep-Linking:** Automatically link generated code blocks and section headers back to the exact YouTube timestamp (`?t=123s`).
- [ ] **Multi-Language Caption Support:** Allow translation and note generation from non-English video transcripts.
- [ ] **Full-Text Search:** Implement PostgreSQL `tsvector` / `tsquery` full-text search across all saved notes in the library.

---

## 13. License & Authors

- **Author:** Sparsh Sharma (`spyspring30@gmail.com`)
- **License:** MIT License (or private repository as specified by project owner)
