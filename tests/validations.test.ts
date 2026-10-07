import { describe, it, expect } from 'vitest';
import {
  notesQuerySchema,
  encodeCursor,
  decodeCursor,
} from '@/lib/validations/notes';
import { generateUrlSchema } from '@/lib/validations/generate';
import { loginSchema, signupSchema } from '@/lib/validations/auth';

describe('Validation Schemas & Keyset Cursors', () => {
  describe('notesQuerySchema', () => {
    it('should parse defaults correctly', () => {
      const parsed = notesQuerySchema.parse({});
      expect(parsed).toEqual({
        cursor: undefined,
        limit: 20,
        search: undefined,
        sort: 'created_at',
        order: 'desc',
      });
    });

    it('should parse and coerce query params', () => {
      const parsed = notesQuerySchema.parse({
        limit: '35',
        search: '  React 19  ',
        sort: 'video_title',
        order: 'asc',
      });
      expect(parsed).toEqual({
        cursor: undefined,
        limit: 35,
        search: 'React 19',
        sort: 'video_title',
        order: 'asc',
      });
    });

    it('should reject invalid limit or sort field', () => {
      expect(() => notesQuerySchema.parse({ limit: '100' })).toThrow();
      expect(() => notesQuerySchema.parse({ limit: '0' })).toThrow();
      expect(() => notesQuerySchema.parse({ sort: 'unsupported_field' })).toThrow();
      expect(() => notesQuerySchema.parse({ order: 'random' })).toThrow();
    });
  });

  describe('encodeCursor & decodeCursor', () => {
    it('should encode and decode cursor round-trip accurately', () => {
      const original = {
        sortValue: '2026-10-06T12:00:00.000Z',
        id: '123e4567-e89b-12d3-a456-426614174000',
        sortField: 'created_at' as const,
        sortOrder: 'desc' as const,
      };

      const encoded = encodeCursor(original);
      expect(typeof encoded).toBe('string');

      const decoded = decodeCursor(encoded, 'created_at', 'desc');
      expect(decoded).toEqual(original);
    });

    it('should return null when expected sort or order differs', () => {
      const encoded = encodeCursor({
        sortValue: '2026-10-06T12:00:00.000Z',
        id: '123e4567-e89b-12d3-a456-426614174000',
        sortField: 'created_at',
        sortOrder: 'desc',
      });

      expect(decodeCursor(encoded, 'video_title', 'desc')).toBeNull();
      expect(decodeCursor(encoded, 'created_at', 'asc')).toBeNull();
    });

    it('should return null for malformed or tampered cursor strings', () => {
      expect(decodeCursor('not-valid-base64!', 'created_at', 'desc')).toBeNull();
      expect(decodeCursor('e30=', 'created_at', 'desc')).toBeNull(); // empty json object
    });
  });

  describe('generateUrlSchema', () => {
    it('should validate valid YouTube video and short URLs', () => {
      expect(generateUrlSchema.safeParse({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }).success).toBe(true);
      expect(generateUrlSchema.safeParse({ url: 'https://youtu.be/dQw4w9WgXcQ' }).success).toBe(true);
      expect(generateUrlSchema.safeParse({ url: 'https://youtube.com/shorts/dQw4w9WgXcQ' }).success).toBe(true);
    });

    it('should reject invalid non-YouTube URLs', () => {
      expect(generateUrlSchema.safeParse({ url: 'https://vimeo.com/123456' }).success).toBe(false);
      expect(generateUrlSchema.safeParse({ url: 'not-a-url' }).success).toBe(false);
      expect(generateUrlSchema.safeParse({ url: '' }).success).toBe(false);
    });
  });

  describe('auth schemas', () => {
    it('should validate login inputs', () => {
      expect(loginSchema.safeParse({ email: 'user@example.com', password: 'password123' }).success).toBe(true);
      expect(loginSchema.safeParse({ email: 'invalid-email', password: 'password123' }).success).toBe(false);
      expect(loginSchema.safeParse({ email: 'user@example.com', password: '' }).success).toBe(false);
    });

    it('should validate signup password minimum length', () => {
      expect(signupSchema.safeParse({ email: 'user@example.com', password: '123456' }).success).toBe(true);
      expect(signupSchema.safeParse({ email: 'user@example.com', password: '12345' }).success).toBe(false);
    });
  });
});
