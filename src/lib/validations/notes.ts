import { z } from 'zod';

export const SORT_FIELDS = ['created_at', 'video_title'] as const;
export const SORT_ORDERS = ['asc', 'desc'] as const;

export type SortField = (typeof SORT_FIELDS)[number];
export type SortOrder = (typeof SORT_ORDERS)[number];

export const notesQuerySchema = z.object({
  cursor: z.string().trim().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  search: z
    .string()
    .trim()
    .max(100, 'Search query must not exceed 100 characters')
    .optional()
    .transform((val) => (val && val.length > 0 ? val : undefined)),
  sort: z.enum(SORT_FIELDS).default('created_at'),
  order: z.enum(SORT_ORDERS).default('desc'),
});

export type NotesQueryInput = z.input<typeof notesQuerySchema>;
export type NotesQueryParams = z.infer<typeof notesQuerySchema>;

export interface KeysetCursor {
  sortValue: string;
  id: string;
  sortField: SortField;
  sortOrder: SortOrder;
}

/**
 * Encodes a keyset cursor into an opaque Base64 URL-safe string.
 */
export function encodeCursor(cursor: KeysetCursor): string {
  const payload = JSON.stringify({
    v: cursor.sortValue,
    i: cursor.id,
    f: cursor.sortField,
    o: cursor.sortOrder,
  });
  return Buffer.from(payload, 'utf8').toString('base64url');
}

/**
 * Decodes and validates an opaque Base64 URL-safe keyset cursor.
 * Returns null if the cursor is malformed or invalid.
 */
export function decodeCursor(
  encodedCursor: string,
  expectedSort: SortField,
  expectedOrder: SortOrder
): KeysetCursor | null {
  try {
    const raw = Buffer.from(encodedCursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(raw);

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof parsed.v !== 'string' ||
      typeof parsed.i !== 'string' ||
      typeof parsed.f !== 'string' ||
      typeof parsed.o !== 'string'
    ) {
      return null;
    }

    // Verify sort field and order match the current query semantics
    if (parsed.f !== expectedSort || parsed.o !== expectedOrder) {
      return null;
    }

    // Validate UUID format for id
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(parsed.i)) {
      return null;
    }

    return {
      sortValue: parsed.v,
      id: parsed.i,
      sortField: parsed.f as SortField,
      sortOrder: parsed.o as SortOrder,
    };
  } catch {
    return null;
  }
}
