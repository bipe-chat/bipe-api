# bipe-api: agent notes

Bipe API: invite sign-up and the handle directory (docs/usernames.md option A). Contract: `../bipe-shared/api/openapi.yaml`. Change the contract first, then the code.

- Stack: Node 24, TypeScript, Hono, pg, Zod. pnpm only. Exact versions in package.json.
- Green gate: `pnpm build`.
- `src/generated/` comes from `../bipe-shared` (`pnpm gen`). Never edit it. Handle rules and normalisation live in bipe-shared and must match its test vectors.
- Runs on the dev node in Docker Compose (`../bipe-infra/compose`, service `api`, host `api.bipe.chat`). Postgres database `bipe` on the shared Postgres.
- MAS admin API: client_credentials with scope `urn:mas:admin`. The client ID and secret come from `.env` on the node; never log or print them. MAS cannot delete users: a failed sign-up deactivates the MAS user and refunds the invite use.
- Never log request bodies, emails, passwords, tokens or invite codes. Invite codes are stored only as SHA-256 hashes.
- Rate limits are in memory: one instance only.
- Admin CLI (in the container): `node dist/cli.js invite create --uses 10 --days 12 --note amigos`, `invite list`, `invite revoke <id>`, `invite grant @user:bipe.net.br 5` (extra personal invites), `invite revoke-user @user:bipe.net.br` (all pending invites of a user), `invite top --limit 50` (inviters ranked by joins: sent, joined, rate, downstream tree size and depth), `handle set @user:bipe.net.br <handle>` (staff: sets a handle without the 30-day cooldown; it still validates with the user as claimant, so an owned 2-character handle works only for its owner (ADR 0065), still puts the old skeleton on hold and still refuses a handle that another user holds or keeps on hold). The same report is `GET /v1/admin/inviters` for the page `bipe.chat/admin/convites/` (ADR 0056 in bipe/docs/adr): `StaffGate` lets only MAS admins through and answers `not_found` to everyone else.
- Personal invites (`/v1/me/invites`): `created_by` set, single use, 30 days. Pending invites hold a slot until they expire or are revoked; used invites hold it for `INVITE_RESPAWN_DAYS` (default 7) after the invitee joined, then it comes back. Quota = `INVITES_PER_USER` (default 10) + `invite_grants.extra`. Creation takes a per-user advisory lock so two requests cannot take the last slot.
- `GET /v1/me/invite-connections`: the caller's invite pairs (people they invited who joined, plus their inviter). Clients skip Pedidos for DM invites from these users (ADR 0034 in bipe/docs/adr).
- `GET /v1/invites/{code}` is public with CORS for `PUBLIC_SITE_URL` (the invite page reads it). It never says why a code is invalid.
- `POST /v1/waitlist` (ADR 0025) is public with CORS for `PUBLIC_SITE_URL`. It answers 202 for every well-formed request, duplicates and the `website` honeypot included, so it never tells whether an address is known. Admin CLI: `waitlist count`, `waitlist export android`, `waitlist clear android` (after the launch email), `waitlist forget <email>`.
- `POST /v1/events` (ADR 0032) counts headline-test events as daily aggregates: no IP, no identifier. The site sends it with `sendBeacon` (text/plain JSON, no CORS). Report: `node dist/cli.js experiment report headline-77`. Run the report before `waitlist clear`: sign-ups per arm come from waitlist rows.
- CNPJ verification (ADR 0042 in bipe/docs/adr, docs/cnpj-verification.md): `/v1/me/business*`. The registry is the Receita release on disk (`RECEITA_DIR`, host `compose/data/receita`), scanned for claimed CNPJs only; never bulk-import it (4 GB node). e-CNPJ proof needs the pinned roots in `certs/icp-brasil/` (`ICP_BRASIL_ROOTS_DIR`); without them the route answers `internal` with reason `icp_brasil_roots_missing`. Never store a signature or a certificate. CLI: `registry fetch [YYYY-MM]`, `registry scan [--all]` (run `--all` after each monthly fetch), `business list`, `business verify @user`, `business revoke @user`. One scan at a time (advisory lock 7140142).
- Receita's WebDAV share answers 200 with an empty body unless the request has a PROPFIND body and a browser-like user agent.
- Public profiles (ADR 0041 in bipe/docs/adr): `GET /v1/profiles/{handle}` and its `/photo` are public with CORS for `PUBLIC_SITE_URL`, exact handle only, and answer the same 404 for "no handle" and "profile off". `PUT /v1/me/profile/photo` takes a JPEG up to `photoMaxBytes` (the only route with a larger body limit). `stripJpeg()` drops every APPn and COM segment and fails closed on anything it cannot parse. Photo URLs use `PUBLIC_API_URL`. No badge store exists yet, so profiles carry no badge.
- Invite codes: `extractInviteCode()` finds the code in a bare code, a link or a pasted message. It must pass `../bipe-shared/test-vectors/invite-codes.json` (iOS and Android pass the same file).
- Write docs in ASD-STE100 style.

## Decisions

Product and architecture decisions for all Bipe repos are ADRs in the umbrella repo: `../bipe/docs/adr/` (index: `README.md`). Check them before changing a decided behaviour. A new decision gets an ADR there, not a note in this repo.
