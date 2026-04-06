# 📝 CodeNotes AI

CodeNotes is a full-stack Next.js application that automatically extracts transcripts from YouTube videos and uses Google's Gemini AI to generate structured, intelligent study notes. All notes are saved to a live PostgreSQL database on Supabase.

## 🚀 Features
- **Instant Transcription:** Fetches captions directly from YouTube URLs.
- **AI Summarization:** Uses Gemini 2.5 Flash to generate readable, structured study notes.
- **Cloud Storage:** Automatically saves and retrieves notes from a live Supabase PostgreSQL database.
- **Production Ready:** Fully deployed on Vercel with a custom IPv4 connection pooler.

## 🛠️ Tech Stack
- **Frontend & Backend:** Next.js (App Router)
- **Database:** PostgreSQL (Supabase)
- **AI:** Google Gemini API
- **Deployment:** Vercel

## 💻 Running Locally

### 1. Clone the repository
```bash
git clone [https://github.com/YourUsername/CodeNotes.git](https://github.com/YourUsername/CodeNotes.git)
cd CodeNotes
```
2. Install dependencies
 ```
npm install
```
4. Environment Variables
Create a .env.local file in the root of your project.

Important: This project uses a "Split-Brain" database setup. Local development uses a direct IPv6 connection, while production uses an IPv4 connection pooler.

Add the following keys to your .env.local file:

Code snippet
```
# Google Gemini API Key
GEMINI_API_KEY="your_gemini_api_key_here"

# Direct IPv6 Database URL for Local Development
DATABASE_URL="postgresql://postgres:[YOUR-PASSWORD]@db.[YOUR-PROJECT-REF].supabase.co:5432/postgres"
```
4. Start the Development Server
npm run dev
Open http://localhost:3000 in your browser to see the app.

☁️ Deployment (Vercel)
When deploying to Vercel, you must use the IPv4 Connection Pooler URL for the database, as Vercel does not support IPv6.

Add these Environment Variables in your Vercel Project Settings:

GEMINI_API_KEY: Your Gemini API Key

DATABASE_URL: postgresql://postgres.[YOUR-PROJECT-REF]:[YOUR-PASSWORD]@aws-0-ap-south-1.pooler.supabase.com:6543/postgres?pgbouncer=true

Note: Ensure ?pgbouncer=true is appended to the end of the Vercel database URL!

