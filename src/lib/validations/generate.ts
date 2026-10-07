import { z } from 'zod';

const YOUTUBE_URL_REGEX = /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|embed\/|v\/|shorts\/)|youtu\.be\/)[\w-]{11}(\S*)?$/;

export const generateUrlSchema = z.object({
  url: z
    .string()
    .trim()
    .min(1, 'YouTube URL is required')
    .max(500, 'URL is too long')
    .refine((val) => YOUTUBE_URL_REGEX.test(val), {
      message: 'Please enter a valid YouTube video URL (e.g., https://youtube.com/watch?v=... or https://youtu.be/...)',
    }),
});

export type GenerateUrlInput = z.infer<typeof generateUrlSchema>;
