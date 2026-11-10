// Link preview head for invite links (bipe#459). The site edge sends only link-preview crawlers here;
// browsers get the static invite page. Public profile fields only, and the image URL never holds the code.
import type { Db } from "./db.js";
import { extractInviteCode, inviteExpiryLabel, inviteHash } from "./invites.js";
import { appString } from "./registry.js";

type Invite = { handle: string | null; name: string | null; photo_version: string | null; expires_at: Date };

const escape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** A usable invite: its expiry and, for a personal invite with a handle, the inviter. Null when unusable; never says why. */
async function inviteOf(db: Db, text: string): Promise<Invite | null> {
  const code = extractInviteCode(text);
  if (!code) return null;
  const { rows } = await db.query<Invite>(
    `SELECT h.handle, CASE WHEN p.enabled THEN p.name END AS name, CASE WHEN p.enabled THEN p.photo_version END AS photo_version,
            i.expires_at
     FROM invites i LEFT JOIN handles h ON h.user_id = i.created_by
     LEFT JOIN public_profiles p ON p.user_id = i.created_by
     WHERE i.code_hash = $1 AND i.uses_left > 0 AND i.expires_at > now() AND i.revoked_at IS NULL`,
    [inviteHash(code)],
  );
  return rows[0] ?? null;
}

export async function invitePreviewHtml(db: Db, siteUrl: string, apiUrl: string, text: string): Promise<string> {
  const site = siteUrl.replace(/\/$/, "");
  const invite = await inviteOf(db, text);
  const inviter = invite?.handle ? { ...invite, handle: invite.handle } : null;
  const who = inviter ? (inviter.name?.trim() || `@${inviter.handle}`) : null;
  const title = who ? appString("pt", "bipe_onboarding_invited_by", who).replace(/\.$/, "") : "Convite para o Bipe";
  // Same text as the static invite page (bipe-web copy.ts invite.lead and route title), after the expiry for urgency.
  const lead = "Um app de mensagens brasileiro que avisa quando tem golpe e esconde seu número.";
  const description = invite ? `${appString("pt", "bipe_invite_link_expires", inviteExpiryLabel(invite.expires_at))} ${lead}` : lead;
  const photo = inviter?.photo_version
    ? `${apiUrl.replace(/\/$/, "")}/v1/profiles/${encodeURIComponent(inviter.handle)}/photo?v=${inviter.photo_version}`
    : null;
  const image = photo
    ? `<meta property="og:image" content="${escape(photo)}">\n<meta property="og:image:type" content="image/jpeg">`
    : `<meta property="og:image" content="${site}/og/convite.jpg">\n<meta property="og:image:type" content="image/jpeg">\n<meta property="og:image:width" content="1200">\n<meta property="og:image:height" content="630">`;
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
<meta property="og:image" content="${site}/og/grupo.jpg">
<meta property="og:image:type" content="image/jpeg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${escape(title)}">
<meta name="twitter:card" content="summary_large_image">
</head>
<body><p><a href="${site}/convite/">${escape(title)}</a></p></body>
</html>
`;
}
