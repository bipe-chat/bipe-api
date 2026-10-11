# proseio-api: agent notes

Proseio API: invite sign-up and the handle directory (docs/usernames.md option A). Contract: `../proseio-shared/api/openapi.yaml`. Change the contract first, then the code.

- Stack: Node 24, TypeScript, Hono, pg, Zod. pnpm only. Exact versions in package.json.
- Green gate: `pnpm build`.
- `src/generated/` comes from `../proseio-shared` (`pnpm gen`). Never edit it. Handle rules and normalisation live in proseio-shared and must match its test vectors.
- Runs on the dev node in Docker Compose (`../proseio-infra/compose`, service `api`, host `api.proseio.com.br`). Postgres database `proseio` on the shared Postgres.
- MAS admin API: client_credentials with scope `urn:mas:admin`. The client ID and secret come from `.env` on the node; never log or print them. MAS cannot delete users: a failed sign-up deactivates the MAS user and refunds the invite use.
- Never log request bodies, emails, passwords, tokens or invite codes. Invite codes are stored only as SHA-256 hashes.
- Rate limits are in memory: one instance only.
- Admin CLI (in the container): `node dist/cli.js invite create --uses 10 --days 12 --note amigos`, `invite list`, `invite revoke <id>`, `invite grant @user:proseio.com.br 5` (extra personal invites), `invite revoke-user @user:proseio.com.br` (all pending invites of a user).
- Personal invites (`/v1/me/invites`): `created_by` set, single use, 30 days. Pending invites hold a slot until they expire or are revoked; used invites hold it for `INVITE_RESPAWN_DAYS` (default 7) after the invitee joined, then it comes back. Quota = `INVITES_PER_USER` (default 10) + `invite_grants.extra`. Creation takes a per-user advisory lock so two requests cannot take the last slot.
- `GET /v1/invites/{code}` is public with CORS for `PUBLIC_SITE_URL` (the invite page reads it). It never says why a code is invalid.
- Invite codes: `extractInviteCode()` finds the code in a bare code, a link or a pasted message. It must pass `../proseio-shared/test-vectors/invite-codes.json` (iOS and Android pass the same file).
- Write docs in ASD-STE100 style.

## Decisions

Product and architecture decisions for all Proseio repos are ADRs in the umbrella repo: `../proseio/docs/adr/` (index: `README.md`). Check them before changing a decided behaviour. A new decision gets an ADR there, not a note in this repo.
