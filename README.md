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
