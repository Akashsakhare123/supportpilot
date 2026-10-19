import {
  and,
  asc,
  type Database,
  desc,
  eq,
  messages,
  type MessageRow,
  sql,
  users,
} from '@supportpilot/db';
import { HISTORY_PAGE } from '@supportpilot/shared';

export interface MessagePageInput {
  tenantId: string;
  conversationId: string;
  /** Older messages than this id (scrolling up). */
  before?: string;
  /** Newer messages than this id (sync after a reconnect). */
  after?: string;
  limit?: number;
  /** The widget never shows system notes. */
  hideSystem?: boolean;
}

export interface MessagePageRows {
  rows: { message: MessageRow; authorName: string | null }[];
  hasMore: boolean;
}

/**
 * One page of a conversation's messages, oldest first, with keyset pagination on
 * (created_at, id). The cursor is compared inside SQL (a subquery), not as a JS Date, because
 * Postgres keeps microseconds and a Date would round them away. Returns null for an unknown cursor.
 */
export async function loadMessagePage(
  db: Database,
  input: MessagePageInput,
): Promise<MessagePageRows | null> {
  const size = input.limit ?? HISTORY_PAGE.default;
  const cursorId = input.before ?? input.after;
  if (cursorId) {
    const cursor = await db.query.messages.findFirst({
      where: and(
        eq(messages.id, cursorId),
        eq(messages.conversationId, input.conversationId),
        eq(messages.tenantId, input.tenantId),
      ),
      columns: { id: true },
    });
    if (!cursor) return null;
  }
  const position = sql`(select m.created_at, m.id from messages m where m.id = ${cursorId ?? null})`;
  const forward = Boolean(input.after);
  const rows = await db
    .select({ message: messages, authorName: users.name })
    .from(messages)
    .leftJoin(users, eq(users.id, messages.userId))
    .where(
      and(
        eq(messages.tenantId, input.tenantId),
        eq(messages.conversationId, input.conversationId),
        input.hideSystem ? sql`${messages.sender} <> 'system'` : undefined,
        input.before ? sql`(${messages.createdAt}, ${messages.id}) < ${position}` : undefined,
        input.after ? sql`(${messages.createdAt}, ${messages.id}) > ${position}` : undefined,
      ),
    )
    .orderBy(
      ...(forward
        ? [asc(messages.createdAt), asc(messages.id)]
        : [desc(messages.createdAt), desc(messages.id)]),
    )
    .limit(size + 1);
  const hasMore = rows.length > size;
  const page = rows.slice(0, size);
  return { rows: forward ? page : page.reverse(), hasMore };
}
