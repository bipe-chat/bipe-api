// Link preview head for invite links (bipe#459). The site edge sends only link-preview crawlers here;
// browsers get the static invite page. Public profile fields only, and the image URL never holds the code.
import type { Db } from "./db.js";
import { extractInviteCode, inviteHash } from "./invites.js";
import { appString } from "./registry.js";

type Inviter = { handle: string; name: string | null; photo_version: string | null };

const escape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** The inviter of a usable personal invite with a handle, or null. Never says why. */
async function inviterOf(db: Db, text: string): Promise<Inviter | null> {
  const code = extractInviteCode(text);
  if (!code) return null;
  const { rows } = await db.query<Inviter>(
    `SELECT h.handle, CASE WHEN p.enabled THEN p.name END AS name, CASE WHEN p.enabled THEN p.photo_version END AS photo_version
     FROM invites i JOIN handles h ON h.user_id = i.created_by
     LEFT JOIN public_profiles p ON p.user_id = i.created_by
     WHERE i.code_hash = $1 AND i.uses_left > 0 AND i.expires_at > now() AND i.revoked_at IS NULL`,
    [inviteHash(code)],
  );
  return rows[0] ?? null;
}

export async function invitePreviewHtml(db: Db, siteUrl: string, apiUrl: string, text: string): Promise<string> {
  const site = siteUrl.replace(/\/$/, "");
  const inviter = await inviterOf(db, text);
  const who = inviter ? (inviter.name?.trim() || `@${inviter.handle}`) : null;
  const title = who ? appString("pt", "bipe_onboarding_invited_by", who).replace(/\.$/, "") : "Convite para o Bipe";
  // Same text as the static invite page (bipe-web copy.ts invite.lead and route title).
  const description = "Um app de mensagens brasileiro que avisa quando tem golpe e esconde seu número.";
  const photo = inviter?.photo_version
    ? `${apiUrl.replace(/\/$/, "")}/v1/profiles/${encodeURIComponent(inviter.handle)}/photo?v=${inviter.photo_version}`
    : null;
  const image = photo
    ? `<meta property="og:image" content="${escape(photo)}">\n<meta property="og:image:type" content="image/jpeg">`
    : `<meta property="og:image" content="${site}/og/convite.png">\n<meta property="og:image:type" content="image/png">\n<meta property="og:image:width" content="1200">\n<meta property="og:image:height" content="630">`;
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="robots" content="noindex">
<meta name="referrer" content="no-referrer">
<title>${escape(title)}</title>
<meta name="description" content="${escape(description)}">
<meta property="og:title" content="${escape(title)}">
<meta property="og:description" content="${escape(description)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Bipe">
<meta property="og:locale" content="pt_BR">
${image}
<meta property="og:image:alt" content="${escape(title)}">
<meta name="twitter:card" content="${photo ? "summary" : "summary_large_image"}">
</head>
<body><p><a href="${site}/convite/">${escape(title)}</a></p></body>
</html>
`;
}

/** Link preview head for a group link (bipe-chat/bipe#744): the group name and member count, never member names. */
export function groupLinkPreviewHtml(siteUrl: string, preview: { valid: boolean; name?: string; members?: number }): string {
  const site = siteUrl.replace(/\/$/, "");
  const valid = preview.valid && preview.members !== undefined;
  const title = valid && preview.name ? appString("pt", "bipe_group_link_preview_title", preview.name) : "Convite para o Bipe";
  // Same text as the static invite page (bipe-web copy.ts invite.lead) when the link does not work.
  const description = valid
    ? appString("pt", "bipe_group_link_preview_count", String(preview.members))
    : "Um app de mensagens brasileiro que avisa quando tem golpe e esconde seu número.";
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="robots" content="noindex">
<meta name="referrer" content="no-referrer">
<title>${escape(title)}</title>
<meta name="description" content="${escape(description)}">
<meta property="og:title" content="${escape(title)}">
<meta property="og:description" content="${escape(description)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Bipe">
<meta property="og:locale" content="pt_BR">
<meta property="og:image" content="${site}/og/convite.png">
<meta property="og:image:type" content="image/png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${escape(title)}">
<meta name="twitter:card" content="summary_large_image">
</head>
<body><p><a href="${site}/convite/">${escape(title)}</a></p></body>
</html>
`;
}
