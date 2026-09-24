import { NextResponse } from 'next/server';
import { fetchTranscript, extractVideoTitle } from '@/lib/transcript';
import { generateNotes } from '@/lib/gemini';
import { query } from '@/lib/db';
import { logger } from '@/lib/logger';
import { getRequestId } from '@/lib/request-context';
import { recordHttpRequest, recordGenerateStageDuration } from '@/lib/metrics';
import crypto from 'crypto';

export async function POST(request: Request) {
  const startTime = performance.now();
  const requestId = getRequestId(request);

  try {
    const { url } = await request.json();

    if (!url) {
      const durationMs = performance.now() - startTime;
      recordHttpRequest('POST', '/api/generate', 400, durationMs / 1000);
      logger.warn('generate_request_validation_failed', {
        requestId,
        method: 'POST',
        path: '/api/generate',
        status: 400,
        durationMs,
        reason: 'Missing YouTube URL',
      });
      return NextResponse.json(
        { error: 'YouTube URL is required' },
        { status: 400, headers: { 'x-request-id': requestId } }
      );
    }

    // 1. Fetch transcript and video ID
    const t0Transcript = performance.now();
    const { text, videoId } = await fetchTranscript(url);
    const transcriptDurationMs = performance.now() - t0Transcript;
    recordGenerateStageDuration('transcript_fetch', transcriptDurationMs / 1000);

    // 2. Fetch video title
    const t0Title = performance.now();
    const videoTitle = await extractVideoTitle(url);
    const titleDurationMs = performance.now() - t0Title;
    recordGenerateStageDuration('title_fetch', titleDurationMs / 1000);

    // 3. Generate notes using Gemini
    const t0Gemini = performance.now();
    const aiNotes = await generateNotes(text, videoTitle);
    const geminiDurationMs = performance.now() - t0Gemini;
    recordGenerateStageDuration('gemini_inference', geminiDurationMs / 1000);

    // 4. Save to DB
    const noteId = crypto.randomUUID();
    const thumbnailUrl = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
    
    const insertQuery = `
      INSERT INTO notes (id, video_id, video_title, video_url, thumbnail_url, overview, key_concepts, detailed_notes, shorthands)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *;
    `;
    
    const t0Db = performance.now();
    await query(insertQuery, [
      noteId,
      videoId,
      videoTitle,
      url,
      thumbnailUrl,
      aiNotes.overview,
      aiNotes.keyConcepts,
      aiNotes.detailedNotes,
      aiNotes.shorthands
    ]);
    const dbDurationMs = performance.now() - t0Db;
    recordGenerateStageDuration('db_insert', dbDurationMs / 1000);

    const totalDurationMs = performance.now() - startTime;
    recordHttpRequest('POST', '/api/generate', 200, totalDurationMs / 1000);

    logger.info('generate_request_completed', {
      requestId,
      method: 'POST',
      path: '/api/generate',
      status: 200,
      durationMs: totalDurationMs,
      videoId,
      timings: {
        transcriptFetchMs: Math.round(transcriptDurationMs * 100) / 100,
        titleFetchMs: Math.round(titleDurationMs * 100) / 100,
        geminiInferenceMs: Math.round(geminiDurationMs * 100) / 100,
        dbInsertMs: Math.round(dbDurationMs * 100) / 100,
      },
    });

    return NextResponse.json(
      { success: true, noteId },
      { headers: { 'x-request-id': requestId } }
    );
  } catch (error: any) {
    const durationMs = performance.now() - startTime;
    recordHttpRequest('POST', '/api/generate', 500, durationMs / 1000);
    logger.error('generate_request_failed', {
      requestId,
      method: 'POST',
      path: '/api/generate',
      status: 500,
      durationMs,
      errorMessage: error.message || 'Unknown error',
      errorStack: error.stack,
    });

    const clientErrorMessage = error.message?.includes('timed out')
      ? 'Note generation timed out. Please try again with a shorter video.'
      : (error.message || 'Something went wrong');

    return NextResponse.json(
      { error: clientErrorMessage },
      { status: 500, headers: { 'x-request-id': requestId } }
    );
  }
}
