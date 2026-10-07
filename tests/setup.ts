// Set mock environment variables for testing isolation
process.env.DATABASE_URL = 'postgresql://mock_user:mock_password@localhost:5432/mock_db';
process.env.GEMINI_API_KEY = 'mock_gemini_api_key';
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://mock-project.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'mock-anon-key';
