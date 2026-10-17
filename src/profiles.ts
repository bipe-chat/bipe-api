// Public profiles (ADR 0041 in bipe/docs/adr). Opt-in, reachable by the exact handle only, separate from
// the Matrix profile. A verified company's profile carries its signed badge (bipe#399).
import { randomBytes } from "node:crypto";
import type { Badges } from "./badges.js";
import type { Db } from "./db.js";
import { ApiError } from "./errors.js";
import { problemWithProfile, profileRules } from "./registry.js";

type Row = { enabled: boolean; name: string; bio: string; photo_version: string | null };

const photoUrl = (apiUrl: string, handle: string, version: string) =>
  `${apiUrl.replace(/\/$/, "")}/v1/profiles/${encodeURIComponent(handle)}/photo?v=${version}`;

/** Lowercase exact match; anything that is not a valid handle shape is simply not found. */
function handleKey(raw: string): string {
  return raw.replace(/^@/, "").toLowerCase();
}

export async function publicProfile(db: Db, apiUrl: string, raw: string, badges: Badges) {
  const { rows } = await db.query<Row & { handle: string; user_id: string }>(
    `SELECT h.handle, h.user_id, p.enabled, p.name, p.bio, p.photo_version
     FROM handles h JOIN public_profiles p ON p.user_id = h.user_id
     WHERE h.handle = $1 AND p.enabled`,
    [handleKey(raw)],
  );
  const row = rows[0];
  if (!row) throw new ApiError("not_found");
  // The same envelope as GET /v1/badges/{userId}. A badge failure must not hide the profile: no badge then.
  const badge = await badges.forUser(row.user_id).catch((e: Error) => {
    console.error(`profile badge failed: ${e.message}`);
    return null;
  });
  return {
    handle: row.handle,
    name: row.name,
    ...(row.bio ? { bio: row.bio } : {}),
    ...(row.photo_version ? { photo_url: photoUrl(apiUrl, row.handle, row.photo_version) } : {}),
    ...(badge?.status === 200 ? { badge: badge.envelope } : {}),
  };
}

export async function publicPhoto(db: Db, raw: string): Promise<Buffer> {
  const { rows } = await db.query<{ photo: Buffer }>(
    `SELECT p.photo FROM handles h JOIN public_profiles p ON p.user_id = h.user_id
     WHERE h.handle = $1 AND p.enabled AND p.photo IS NOT NULL`,
    [handleKey(raw)],
  );
  if (!rows[0]) throw new ApiError("not_found");
  return rows[0].photo;
}

export async function myProfile(db: Db, apiUrl: string, userId: string) {
  const { rows } = await db.query<Row & { handle: string | null }>(
    `SELECT h.handle, p.enabled, p.name, p.bio, p.photo_version
     FROM (SELECT $1::text AS user_id) u
     LEFT JOIN public_profiles p ON p.user_id = u.user_id
     LEFT JOIN handles h ON h.user_id = u.user_id`,
    [userId],
  );
  const row = rows[0]!;
  return {
    enabled: (row.enabled ?? false) && row.handle !== null,
    name: row.name ?? "",
    bio: row.bio ?? "",
    has_photo: row.photo_version !== null,
    ...(row.handle ? { handle: row.handle } : {}),
    ...(row.handle && row.photo_version ? { photo_url: photoUrl(apiUrl, row.handle, row.photo_version) } : {}),
  };
}

export async function saveProfile(
  db: Db,
  apiUrl: string,
  userId: string,
  update: { enabled: boolean; name: string; bio: string },
) {
  const name = update.name.trim();
  const bio = update.bio.trim().replace(/\r\n?/g, "\n");
  // An empty draft may be saved while the profile is off; a published profile must pass every rule.
  if (update.enabled || name || bio) {
    const problem = problemWithProfile(name, bio);
    if (problem && (update.enabled || problem !== "name_empty")) throw new ApiError("profile_invalid", problem);
  }
  if (update.enabled) {
    const { rowCount } = await db.query("SELECT 1 FROM handles WHERE user_id = $1", [userId]);
    if (!rowCount) throw new ApiError("profile_invalid", "no_handle");
  }
  await db.query(
    `INSERT INTO public_profiles (user_id, enabled, name, bio) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id) DO UPDATE SET enabled = EXCLUDED.enabled, name = EXCLUDED.name, bio = EXCLUDED.bio, updated_at = now()`,
    [userId, update.enabled, name, bio],
  );
  return myProfile(db, apiUrl, userId);
}

export async function setPhoto(db: Db, apiUrl: string, userId: string, body: Uint8Array) {
  const photo = stripJpeg(body);
  await db.query(
    `INSERT INTO public_profiles (user_id, photo, photo_version) VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET photo = EXCLUDED.photo, photo_version = EXCLUDED.photo_version, updated_at = now()`,
    [userId, photo, randomBytes(6).toString("base64url")],
  );
  return myProfile(db, apiUrl, userId);
}

export async function deletePhoto(db: Db, apiUrl: string, userId: string) {
  await db.query("UPDATE public_profiles SET photo = NULL, photo_version = NULL, updated_at = now() WHERE user_id = $1", [userId]);
  return myProfile(db, apiUrl, userId);
}

const SOF = new Set([0xc0, 0xc1, 0xc2]);

/**
 * Checks a JPEG and copies it without APPn (EXIF, GPS, XMP, ICC) and COM segments.
 * Fails closed: anything this parser does not understand is photo_invalid.
 */
export function stripJpeg(input: Uint8Array): Buffer {
  const b = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (b.length > profileRules.photoMaxBytes) throw new ApiError("photo_invalid", "too_large");
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) throw new ApiError("photo_invalid", "not_jpeg");
  const out: Buffer[] = [b.subarray(0, 2)];
  let i = 2;
  let size: { w: number; h: number } | null = null;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) throw new ApiError("photo_invalid", "not_jpeg");
    const marker = b[i + 1]!;
    if (marker === 0xff) { i += 1; continue; } // fill byte
    const len = b.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > b.length) throw new ApiError("photo_invalid", "not_jpeg");
    const segment = b.subarray(i, i + 2 + len);
    if (SOF.has(marker)) {
      if (len < 7) throw new ApiError("photo_invalid", "not_jpeg");
      size = { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
    }
    if (marker === 0xda) {
      // Start of scan: entropy-coded data and the later markers follow. Keep the rest as it is.
      if (!size) throw new ApiError("photo_invalid", "not_jpeg");
      out.push(b.subarray(i));
      break;
    }
    const isMetadata = (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe;
    if (!isMetadata) out.push(segment);
    i += 2 + len;
  }
  if (!size || out.length < 2 || !out.at(-1)!.subarray(0, 2).equals(Buffer.from([0xff, 0xda]))) {
    throw new ApiError("photo_invalid", "not_jpeg");
  }
  const max = profileRules.photoMaxPixels;
  if (size.w === 0 || size.h === 0 || size.w > max || size.h > max) throw new ApiError("photo_invalid", "too_large");
  // After the first scan, FF is followed by 00 (stuffing), a restart marker or a real marker.
  // Encoders do not write metadata there; refuse a file that does.
  const scan = out.at(-1)!;
  for (let j = 2; j + 1 < scan.length; j++) {
    if (scan[j] !== 0xff) continue;
    const m = scan[j + 1]!;
    if ((m >= 0xe0 && m <= 0xef) || m === 0xfe) throw new ApiError("photo_invalid", "not_jpeg");
  }
  if (scan.length < 4 || scan[scan.length - 2] !== 0xff || scan[scan.length - 1] !== 0xd9) {
    throw new ApiError("photo_invalid", "not_jpeg");
  }
  return Buffer.concat(out);
}
