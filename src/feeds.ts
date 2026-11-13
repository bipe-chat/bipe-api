// Public feed at bipe.chat/@handle (ADR 0280, ADR 0281, bipe-chat/bipe#1177; contract: bipe-shared api/openapi.yaml).
// One handle has one feed, linked to one group. The admin's app sends a plain copy of each group post here; the service
// reads no room and no message. It reads only the room state (power levels, create) through the Synapse admin API, to
// check that the caller is an admin. The page shows the handle owner's public profile, never the admin who posted.
// A feed is `test` while the Public Canal gate is closed: staff make it with the CLI, and its pages are noindex.
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { Badges } from "./badges.js";
import type { Db } from "./db.js";
import { ApiError } from "./errors.js";
import { roomFacts, type RoomStateEvent } from "./group-links.js";
import { handleKey, publicProfile } from "./profiles.js";
import { FEED_REPORT_REASONS, feedOwner, logFeedAction, postOwner } from "./feed-reports.js";
import { appString } from "./registry.js";
import type { SiteChrome } from "./site-chrome.js";

export const PAGE_SIZE = 20;
const ADMIN_LEVEL = 50;
export const FEED_STATUSES = ["test", "live"] as const;
export type FeedStatus = (typeof FEED_STATUSES)[number];

export const FeedPostBody = z.object({ text: z.string().min(1).max(4000) }).strict();

/** The state reads the service needs. Tests give a fake. */
export interface FeedRoomState {
  roomState(roomId: string): Promise<RoomStateEvent[]>;
}

interface FeedRow {
  user_id: string;
  room_id: string;
  status: FeedStatus;
}

interface PostRow {
  id: string;
  body: string;
  created_at: Date;
}

/** A Pix BR Code (EMV payload) in the text. ADR 0280 point 6: no payment in a post. */
const PAYMENT = /\b000201(?:010211|010212|26\d\d)/;

const newPostId = () => {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  return Array.from(randomBytes(12), (b) => alphabet[b % 32]).join("");
};

export const postUrl = (siteUrl: string, handle: string, id: string) => `${siteUrl.replace(/\/$/, "")}/@${handle}/p/${id}`;

/** The feed behind a handle when the profile and the feed are on. Null for every other case: the callers answer one 404. */
async function feedOfHandle(db: Db, raw: string): Promise<(FeedRow & { handle: string }) | null> {
  const { rows } = await db.query<FeedRow & { handle: string }>(
    `SELECT f.user_id, f.room_id, f.status, h.handle
     FROM handles h JOIN public_feeds f ON f.user_id = h.user_id JOIN public_profiles p ON p.user_id = h.user_id
     WHERE h.handle = $1 AND p.enabled AND f.enabled`,
    [handleKey(raw)],
  );
  return rows[0] ?? null;
}

function toPost(siteUrl: string, handle: string, row: PostRow) {
  return { id: row.id, text: row.body, created_at: row.created_at.toISOString(), url: postUrl(siteUrl, handle, row.id) };
}

export interface FeedView {
  status: FeedStatus;
  profile: Awaited<ReturnType<typeof publicProfile>>;
  posts: ReturnType<typeof toPost>[];
  next_before?: string;
}

/** GET /v1/feeds/{handle}: newest first, PAGE_SIZE per page, removed posts left out. */
export async function readFeed(db: Db, badges: Badges, siteUrl: string, apiUrl: string, raw: string, before?: string): Promise<FeedView> {
  const feed = await feedOfHandle(db, raw);
  if (!feed) throw new ApiError("not_found");
  let beforeDate: Date | null = null;
  if (before !== undefined) {
    beforeDate = new Date(before);
    if (Number.isNaN(beforeDate.getTime())) throw new ApiError("bad_request", "before");
  }
  const profile = await publicProfile(db, apiUrl, feed.handle, badges);
  const { rows } = await db.query<PostRow>(
    `SELECT id, body, created_at FROM public_feed_posts
     WHERE user_id = $1 AND removed_at IS NULL AND ($2::timestamptz IS NULL OR created_at < $2)
     ORDER BY created_at DESC, id DESC LIMIT $3`,
    [feed.user_id, beforeDate, PAGE_SIZE + 1],
  );
  const page = rows.slice(0, PAGE_SIZE);
  return {
    status: feed.status,
    profile,
    posts: page.map((r) => toPost(siteUrl, feed.handle, r)),
    ...(rows.length > PAGE_SIZE ? { next_before: page[page.length - 1]!.created_at.toISOString() } : {}),
  };
}

/** The JSON answer of GET /v1/feeds/{handle}. Only public profile fields. */
export function publicFeedJson(view: FeedView) {
  const p = view.profile;
  return {
    handle: p.handle,
    name: p.name,
    ...(p.photo_url ? { photo_url: p.photo_url } : {}),
    ...(p.badge ? { badge: p.badge } : {}),
    posts: view.posts,
    ...(view.next_before ? { next_before: view.next_before } : {}),
  };
}

export async function readPost(db: Db, badges: Badges, siteUrl: string, apiUrl: string, raw: string, id: string) {
  const feed = await feedOfHandle(db, raw);
  if (!feed || !/^[a-z0-9]{1,40}$/.test(id)) throw new ApiError("not_found");
  const { rows } = await db.query<PostRow>(
    "SELECT id, body, created_at FROM public_feed_posts WHERE id = $1 AND user_id = $2 AND removed_at IS NULL",
    [id, feed.user_id],
  );
  if (!rows[0]) throw new ApiError("not_found");
  return { status: feed.status, profile: await publicProfile(db, apiUrl, feed.handle, badges), post: toPost(siteUrl, feed.handle, rows[0]) };
}

/** The feeds whose linked room the caller can post to: joined, level 50 or more (a room v12 creator counts). */
async function feedsOfAdmin(db: Db, rooms: FeedRoomState, userId: string): Promise<(FeedRow & { handle: string })[]> {
  const { rows } = await db.query<FeedRow & { handle: string }>(
    `SELECT f.user_id, f.room_id, f.status, h.handle FROM public_feeds f JOIN handles h ON h.user_id = f.user_id WHERE f.enabled`,
  );
  const out: (FeedRow & { handle: string })[] = [];
  for (const feed of rows) {
    // Small list: one feed per handle, pilot owners only. A state read fails closed for that feed.
    const facts = await rooms.roomState(feed.room_id).then(roomFacts, () => null);
    if (facts && facts.membership(userId) === "join" && facts.level(userId) >= ADMIN_LEVEL) out.push(feed);
  }
  return out;
}

/** POST /v1/me/feed/posts. One linked feed only: an admin of two linked groups is refused (not_found), as ADR 0280 point 7c has one feed per group. */
export async function publish(db: Db, rooms: FeedRoomState, siteUrl: string, userId: string, text: string) {
  const body = text.replace(/\r\n?/g, "\n").trim();
  if (!body) throw new ApiError("bad_request", "text");
  if (PAYMENT.test(body)) throw new ApiError("bad_request", "payment_link");
  const feeds = await feedsOfAdmin(db, rooms, userId);
  if (feeds.length !== 1) throw new ApiError("not_found");
  const feed = feeds[0]!;
  const id = newPostId();
  const { rows } = await db.query<PostRow>(
    "INSERT INTO public_feed_posts (id, user_id, author_id, body) VALUES ($1, $2, $3, $4) RETURNING id, body, created_at",
    [id, feed.user_id, userId, body],
  );
  return toPost(siteUrl, feed.handle, rows[0]!);
}

/** DELETE /v1/me/feed/posts/{id}: the handle owner, the author or an admin of the linked room. */
export async function removeOwnPost(db: Db, rooms: FeedRoomState, userId: string, id: string): Promise<void> {
  const { rows } = await db.query<{ user_id: string; author_id: string | null; room_id: string }>(
    `SELECT p.user_id, p.author_id, f.room_id FROM public_feed_posts p JOIN public_feeds f ON f.user_id = p.user_id
     WHERE p.id = $1 AND p.removed_at IS NULL`,
    [id],
  );
  const row = rows[0];
  if (!row) throw new ApiError("not_found");
  let allowed = row.user_id === userId || row.author_id === userId;
  if (!allowed) {
    const facts = await rooms.roomState(row.room_id).then(roomFacts, () => null);
    allowed = !!facts && facts.membership(userId) === "join" && facts.level(userId) >= ADMIN_LEVEL;
  }
  if (!allowed) throw new ApiError("not_found");
  await db.query("UPDATE public_feed_posts SET removed_at = now(), removed_by = 'owner' WHERE id = $1", [id]);
}

// ---- Owner and composer (bipe-chat/bipe#1260) ---------------------------------------------------------------------

export const MyFeedBody = z.object({ enabled: z.boolean() }).strict();
const feedUrl = (siteUrl: string, handle: string) => `${siteUrl.replace(/\/$/, "")}/@${handle}`;

/** GET /v1/me/feed: the caller's feed when staff linked one (the Public Canal gate is closed: nobody self-creates one). */
export async function myFeed(db: Db, siteUrl: string, userId: string) {
  const { rows } = await db.query<{ handle: string; room_id: string; enabled: boolean }>(
    "SELECT h.handle, f.room_id, f.enabled FROM public_feeds f JOIN handles h ON h.user_id = f.user_id WHERE f.user_id = $1",
    [userId],
  );
  const row = rows[0];
  if (!row) throw new ApiError("not_found");
  return { handle: row.handle, room_id: row.room_id, enabled: row.enabled, url: feedUrl(siteUrl, row.handle) };
}

/** PUT /v1/me/feed: off stops new posts and takes the page down; on brings it back (ADR 0280 point 7c). */
export async function setMyFeed(db: Db, siteUrl: string, userId: string, enabled: boolean) {
  const { rowCount } = await db.query("UPDATE public_feeds SET enabled = $2, updated_at = now() WHERE user_id = $1", [userId, enabled]);
  if (!rowCount) throw new ApiError("not_found");
  return myFeed(db, siteUrl, userId);
}

/** GET /v1/me/feed/rooms/{roomId}: the feed this group posts to, for a joined admin of the group. Else not_found. */
export async function feedOfRoom(db: Db, rooms: FeedRoomState, siteUrl: string, userId: string, roomId: string) {
  if (!roomId.startsWith("!") || roomId.length > 255) throw new ApiError("not_found");
  const { rows } = await db.query<{ handle: string }>(
    "SELECT h.handle FROM public_feeds f JOIN handles h ON h.user_id = f.user_id WHERE f.room_id = $1 AND f.enabled",
    [roomId],
  );
  // ADR 0280 point 7c: one feed per group. A room linked to two feeds is refused, as in publish().
  if (rows.length !== 1) throw new ApiError("not_found");
  const facts = await rooms.roomState(roomId).then(roomFacts, () => null);
  if (!facts || facts.membership(userId) !== "join" || facts.level(userId) < ADMIN_LEVEL) throw new ApiError("not_found");
  return { handle: rows[0]!.handle, url: feedUrl(siteUrl, rows[0]!.handle) };
}

// ---- Staff (CLI) ------------------------------------------------------------------------------------------------

/** Links a handle's feed to a room. Only `test` while the Public Canal gate is closed (ADR 0280 point 16). */
export async function staffCreateFeed(db: Db, raw: string, roomId: string): Promise<string> {
  // Room version 12 IDs have no server part (!<hash>); older ones are !<id>:<server>.
  if (!/^![^\s]{1,254}$/.test(roomId)) throw new Error("room_id must start with ! and have no spaces");
  const { rows } = await db.query<{ user_id: string; handle: string }>("SELECT user_id, handle FROM handles WHERE handle = $1", [handleKey(raw)]);
  const owner = rows[0];
  if (!owner) throw new Error("no account has that handle");
  await db.query(
    `INSERT INTO public_feeds (user_id, room_id, status) VALUES ($1, $2, 'test')
     ON CONFLICT (user_id) DO UPDATE SET room_id = EXCLUDED.room_id, enabled = true, updated_at = now()`,
    [owner.user_id, roomId],
  );
  return owner.handle;
}

export async function staffSetFeedEnabled(db: Db, raw: string, enabled: boolean, note?: string): Promise<boolean> {
  const { rowCount } = await db.query(
    "UPDATE public_feeds SET enabled = $2, updated_at = now() WHERE user_id = (SELECT user_id FROM handles WHERE handle = $1)",
    [handleKey(raw), enabled],
  );
  if (!rowCount) return false;
  const owner = await feedOwner(db, raw);
  await logFeedAction(db, enabled ? "feed_on" : "feed_off", { ownerId: owner?.owner_id ?? null, handle: owner?.handle ?? null }, note);
  return true;
}

/** Takedown (#1180): the post leaves the page at once. The row stays with removed_by = 'staff'. */
export async function staffRemovePost(db: Db, id: string, note?: string): Promise<boolean> {
  const { rowCount } = await db.query("UPDATE public_feed_posts SET removed_at = now(), removed_by = 'staff' WHERE id = $1 AND removed_at IS NULL", [id]);
  if (!rowCount) return false;
  const owner = await postOwner(db, id);
  await logFeedAction(db, "remove_post", { ownerId: owner?.owner_id ?? null, handle: owner?.handle ?? null, postId: id }, note);
  return true;
}

/** An appeal that staff grant: a post that staff removed goes back on the page (bipe#1180). Owner removals stay. */
export async function staffRestorePost(db: Db, id: string, note?: string): Promise<boolean> {
  const { rowCount } = await db.query("UPDATE public_feed_posts SET removed_at = NULL, removed_by = NULL WHERE id = $1 AND removed_by = 'staff'", [id]);
  if (!rowCount) return false;
  const owner = await postOwner(db, id);
  await logFeedAction(db, "restore_post", { ownerId: owner?.owner_id ?? null, handle: owner?.handle ?? null, postId: id }, note);
  return true;
}

/** Test feeds only: a post as the handle owner, for a page check before the apps send posts (#1260). */
export async function staffTestPost(db: Db, siteUrl: string, raw: string, text: string) {
  const { rows } = await db.query<{ user_id: string; handle: string; status: FeedStatus }>(
    "SELECT f.user_id, h.handle, f.status FROM public_feeds f JOIN handles h ON h.user_id = f.user_id WHERE h.handle = $1",
    [handleKey(raw)],
  );
  const feed = rows[0];
  if (!feed) throw new Error("no feed for that handle");
  if (feed.status !== "test") throw new Error("staff posts only go to a test feed");
  const body = text.trim();
  if (!body || body.length > 4000) throw new Error("text must be 1 to 4000 characters");
  const id = newPostId();
  const inserted = await db.query<PostRow>(
    "INSERT INTO public_feed_posts (id, user_id, author_id, body) VALUES ($1, $2, NULL, $3) RETURNING id, body, created_at",
    [id, feed.user_id, body],
  );
  return toPost(siteUrl, feed.handle, inserted.rows[0]!);
}

export async function staffListFeeds(db: Db) {
  const { rows } = await db.query<{ handle: string | null; room_id: string; status: string; enabled: boolean; posts: string }>(
    `SELECT h.handle, f.room_id, f.status, f.enabled,
            (SELECT count(*) FROM public_feed_posts p WHERE p.user_id = f.user_id AND p.removed_at IS NULL) AS posts
     FROM public_feeds f LEFT JOIN handles h ON h.user_id = f.user_id ORDER BY f.created_at`,
  );
  return rows.map((r) => ({ ...r, posts: Number(r.posts) }));
}

// ---- HTML and RSS -----------------------------------------------------------------------------------------------

const escape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const URL_RE = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/gi;

/**
 * Post text to HTML: line breaks kept, each http(s) link clickable with its domain shown (ADR 0280 point 6).
 * A host that is not plain ASCII, or is punycode, stays plain text: it can be a lookalike of a known domain.
 */
export function postHtml(text: string): string {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    out += escape(text.slice(last, m.index));
    last = m.index! + m[0].length;
    let host: string | null = null;
    try {
      const u = new URL(m[0]);
      if ((u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password) host = u.hostname;
    } catch {
      host = null;
    }
    // new URL() turns a Unicode host into punycode, so one check covers both.
    if (!host || host.split(".").some((label) => label.startsWith("xn--"))) {
      out += escape(m[0]);
      continue;
    }
    out += `<a href="${escape(m[0])}" rel="nofollow ugc noopener noreferrer">${escape(m[0])}</a> <span class="feed-domain">${escape(host.replace(/^www\./, ""))}</span>`;
  }
  out += escape(text.slice(last));
  return out.replace(/\n/g, "<br>");
}

const dateLabel = (iso: string) =>
  new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));


type PageView = { status: FeedStatus; profile: FeedView["profile"] };
type PageOpts = { siteUrl: string; view: PageView; title: string; canonical: string; description: string; chrome: SiteChrome | null };
/** The parts between the profile head and the install card: bio, posts, links. */
type PageBody = { bio: boolean; posts: string; more: string };

function headTags(opts: PageOpts): string {
  const { profile, status } = opts.view;
  const site = opts.siteUrl.replace(/\/$/, "");
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${status === "test" ? '<meta name="robots" content="noindex,nofollow">\n' : ""}<meta name="referrer" content="strict-origin-when-cross-origin">
<title>${escape(opts.title)}</title>
<meta name="description" content="${escape(opts.description)}">
<link rel="canonical" href="${escape(opts.canonical)}">
<link rel="alternate" type="application/rss+xml" title="${escape(opts.title)}" href="${site}/@${escape(profile.handle)}/rss">
<meta property="og:title" content="${escape(opts.title)}">
<meta property="og:description" content="${escape(opts.description)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Bipe">
<meta property="og:locale" content="pt_BR">
${profile.photo_url ? `<meta property="og:image" content="${escape(profile.photo_url)}">\n` : `<meta property="og:image" content="${site}/og/perfil.jpg">\n<meta property="og:image:type" content="image/jpeg">\n<meta property="og:image:width" content="1200">\n<meta property="og:image:height" content="630">\n<meta name="twitter:card" content="summary_large_image">\n`}`;
}

/** Inside the site chrome (src/site-chrome.ts): the same classes as the site's /@handle profile page. */
function sitePage(opts: PageOpts, chrome: SiteChrome, body: PageBody): string {
  const { profile } = opts.view;
  const site = opts.siteUrl.replace(/\/$/, "");
  const photo = profile.photo_url
    ? `<img class="profile-photo" src="${escape(profile.photo_url)}" alt="" width="112" height="112" referrerpolicy="no-referrer">`
    : "";
  const seal = profile.badge ? ` ${chrome.companySeal}` : "";
  return `<!doctype html>
<html lang="pt-BR">
<head>
${headTags(opts)}${chrome.head}
</head>
<body>
${chrome.before}<section class="wrap narrow section profile">
${photo}<h1 style="overflow-wrap:anywhere"><a href="${site}/@${escape(profile.handle)}" style="color:inherit;text-decoration:none">${escape(profile.name)}</a>${seal}</h1>
<p class="profile-handle">@${escape(profile.handle)}</p>
<p class="feed-label"><span class="chip policy">${escape(appString("pt", "bipe_feed_public_label"))}</span></p>
${body.bio && profile.bio ? `<p class="profile-bio">${escape(profile.bio)}</p>\n` : ""}${body.posts}
${body.more}
<div class="link-card"><div><p><a href="${site}/baixar/">${escape(appString("pt", "bipe_feed_notify", profile.name))}</a></p></div></div>
</section>${chrome.after}
</body>
</html>
`;
}

const STANDALONE_STYLE = `:root{color-scheme:light dark;--bg:#fff;--fg:#101317;--muted:#5b6470;--line:#e4e7eb;--accent:#5b2a86}
@media (prefers-color-scheme:dark){:root{--bg:#101317;--fg:#eef0f3;--muted:#a3abb6;--line:#262b31;--accent:#c9a3f0}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:640px;margin:0 auto;padding:24px 16px 48px}header{display:flex;gap:14px;align-items:center;padding-bottom:16px;border-bottom:1px solid var(--line)}
header img{width:64px;height:64px;border-radius:50%;object-fit:cover}h1{font-size:1.25rem;margin:0}.handle{color:var(--muted);margin:0}
.seal{color:var(--accent);font-weight:600}.label{display:inline-block;font-size:.75rem;border:1px solid var(--line);border-radius:999px;padding:0 8px;color:var(--muted);margin-top:4px}
ol{list-style:none;margin:0;padding:0}article{padding:16px 0;border-bottom:1px solid var(--line);overflow-wrap:anywhere}article p{margin:0 0 8px}a{color:var(--accent)}
.feed-domain{font-size:.8rem;color:var(--muted);border:1px solid var(--line);border-radius:4px;padding:0 4px}time a{color:var(--muted);font-size:.85rem;text-decoration:none}
.feed-empty,.feed-more{color:var(--muted);padding:16px 0;margin:0}.link-card{margin-top:24px;padding:16px;border:1px solid var(--line);border-radius:12px}.link-card p{margin:0}.feed-report{margin-top:8px;color:var(--muted)}.feed-report summary{cursor:pointer}.feed-report fieldset{border:0;padding:0;margin:12px 0}.feed-report label{display:block;padding:4px 0}.feed-report-done{color:var(--muted)}`;

/** Without the site chrome (no fetch has worked yet): the page carries its own small style. */
function standalonePage(opts: PageOpts, body: PageBody): string {
  const { profile } = opts.view;
  const site = opts.siteUrl.replace(/\/$/, "");
  const verified = profile.badge ? ` <span class="seal">✓</span>` : "";
  const photo = profile.photo_url ? `<img src="${escape(profile.photo_url)}" alt="">` : "";
  return `<!doctype html>
<html lang="pt-BR">
<head>
${headTags(opts)}<style>${STANDALONE_STYLE}</style>
</head>
<body><main>
<header>${photo}<div><h1><a href="${site}/@${escape(profile.handle)}" style="color:inherit;text-decoration:none">${escape(profile.name)}</a>${verified}</h1>
<p class="handle">@${escape(profile.handle)}</p><span class="label">${escape(appString("pt", "bipe_feed_public_label"))}</span></div></header>
${body.bio && profile.bio ? `<p>${escape(profile.bio)}</p>\n` : ""}${body.posts}
${body.more}
<div class="link-card"><p><a href="${site}/baixar/">${escape(appString("pt", "bipe_feed_notify", profile.name))}</a></p></div>
</main></body>
</html>
`;
}

function page(opts: PageOpts, body: PageBody): string {
  return opts.chrome ? sitePage(opts, opts.chrome, body) : standalonePage(opts, body);
}

function articleHtml(post: { id: string; text: string; created_at: string; url: string }): string {
  return `<li><article class="feed-post"><p>${postHtml(post.text)}</p><time datetime="${post.created_at}"><a href="${escape(post.url)}">${escape(dateLabel(post.created_at))}</a></time></article></li>`;
}

const snippet = (text: string, max = 160) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

const moreLink = (href: string, label: string) =>
  `<p class="feed-more"><a class="button secondary compact" href="${escape(href)}">${escape(label)}</a></p>`;

export function feedPageHtml(siteUrl: string, view: FeedView, chrome: SiteChrome | null = null): string {
  const site = siteUrl.replace(/\/$/, "");
  const h = view.profile.handle;
  const posts = view.posts.length
    ? `<ol class="feed-posts">\n${view.posts.map(articleHtml).join("\n")}\n</ol>`
    : `<p class="feed-empty">${escape(appString("pt", "bipe_feed_empty"))}</p>`;
  const more = view.next_before ? moreLink(`${site}/@${h}?before=${encodeURIComponent(view.next_before)}`, appString("pt", "bipe_feed_older")) : "";
  return page(
    {
      siteUrl,
      view,
      chrome,
      title: appString("pt", "bipe_feed_page_title", view.profile.name),
      canonical: `${site}/@${h}`,
      description: view.profile.bio ?? appString("pt", "bipe_feed_page_title", view.profile.name),
    },
    { bio: true, posts, more },
  );
}

/** The report form under a post (bipe#1180). A plain form, so it works with no script; the API answers 303 back here. */
function reportHtml(siteUrl: string, apiUrl: string, handle: string, postId: string, reported: boolean): string {
  // The rule page (ADR 0293), linked from the form and from the done line.
  const rules = `<a href="${escape(`${siteUrl.replace(/\/$/, "")}/regras-dos-feeds/`)}">${escape(appString("pt", "bipe_feed_rules"))}</a>`;
  if (reported) return `<p class="feed-report-done" role="status">${escape(appString("pt", "bipe_feed_report_done"))} ${rules}</p>`;
  const action = `${apiUrl.replace(/\/$/, "")}/v1/web/feed/${encodeURIComponent(handle)}/p/${encodeURIComponent(postId)}/report`;
  const reasons = FEED_REPORT_REASONS.map((r) =>
    `<label><input type="radio" name="reason" value="${r}" required> ${escape(appString("pt", `bipe_feed_report_${r}`))}</label>`).join("");
  return `<details class="feed-report"><summary>${escape(appString("pt", "bipe_feed_report"))}</summary>` +
    `<form method="post" action="${escape(action)}"><fieldset><legend>${escape(appString("pt", "bipe_feed_report_title"))}</legend>${reasons}</fieldset>` +
    `<p>${escape(appString("pt", "bipe_feed_report_note"))} ${rules}</p>` +
    `<button type="submit" class="button secondary compact">${escape(appString("pt", "bipe_feed_report_send"))}</button></form></details>`;
}

export function postPageHtml(
  siteUrl: string,
  view: Awaited<ReturnType<typeof readPost>>,
  chrome: SiteChrome | null = null,
  report: { apiUrl: string; reported: boolean } | null = null,
): string {
  const site = siteUrl.replace(/\/$/, "");
  const h = view.profile.handle;
  const reportBlock = report ? reportHtml(siteUrl, report.apiUrl, h, view.post.id, report.reported) : "";
  return page(
    {
      siteUrl,
      view,
      chrome,
      title: `${view.profile.name}: ${snippet(view.post.text, 60)}`,
      canonical: view.post.url,
      description: snippet(view.post.text),
    },
    { bio: false, posts: `<ol class="feed-posts">\n${articleHtml(view.post)}\n</ol>${reportBlock}`, more: moreLink(`${site}/@${h}`, appString("pt", "bipe_feed_all_posts")) },
  );
}

const xml = (s: string) => escape(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");

/** RSS 2.0 (ADR 0281 stage 1): the newest page of posts, plain text in the description. */
export function feedRss(siteUrl: string, view: FeedView): string {
  const site = siteUrl.replace(/\/$/, "");
  const h = view.profile.handle;
  const items = view.posts
    .map((p) => `<item><title>${xml(snippet(p.text, 80))}</title><link>${xml(p.url)}</link><guid isPermaLink="true">${xml(p.url)}</guid><pubDate>${new Date(p.created_at).toUTCString()}</pubDate><description>${xml(p.text)}</description></item>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>${xml(appString("pt", "bipe_feed_page_title", view.profile.name))}</title>
<link>${xml(`${site}/@${h}`)}</link>
<description>${xml(view.profile.bio ?? appString("pt", "bipe_feed_page_title", view.profile.name))}</description>
<language>pt-BR</language>
${items}
</channel></rss>
`;
}
