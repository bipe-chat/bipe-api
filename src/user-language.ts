// The user's language for text the server sends (ADR 0298, bipe#1567): pt or en, default pt. The apps send the
// app's screen language in Accept-Language; the server stores it only when it changes. Personal data: the export
// lists it and the account deletion removes it.
import type { Db } from "./db.js";
import type { Lang } from "./registry.js";

export type { Lang };

/** The language of an Accept-Language header: its first value starting with pt is pt, any other is en; none is null. */
export function langFromHeader(header: string | undefined): Lang | null {
  const first = header?.split(",")[0]?.split(";")[0]?.trim().toLowerCase();
  if (!first) return null;
  return first.startsWith("pt") ? "pt" : "en";
}

/** The stored language of a user; pt when there is none. */
export async function userLanguage(db: Db, userId: string): Promise<Lang> {
  const { rows } = await db.query<{ lang: Lang }>("SELECT lang FROM user_languages WHERE user_id = $1", [userId]);
  return rows[0]?.lang ?? "pt";
}

/**
 * Remembers the languages seen in this process, so an unchanged header costs no database call. A change is written
 * and `onChange` runs with the new language (the news room gets a new name). Never logs a user ID.
 */
export class UserLanguages {
  private readonly seen = new Map<string, Lang>();

  constructor(
    private readonly db: Db,
    private readonly onChange: (userId: string, lang: Lang) => void = () => {},
  ) {}

  async observe(userId: string, lang: Lang): Promise<void> {
    if (this.seen.get(userId) === lang) return;
    const before = await userLanguage(this.db, userId);
    if (before !== lang) {
      await this.db.query(
        `INSERT INTO user_languages (user_id, lang) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET lang = EXCLUDED.lang, updated_at = now()`,
        [userId, lang],
      );
      this.onChange(userId, lang);
    }
    if (this.seen.size > 50_000) this.seen.clear();
    this.seen.set(userId, lang);
  }
}
