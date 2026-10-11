# proseio-api: agent notes

Proseio API: invite sign-up and the handle directory (docs/usernames.md option A). Contract: `../proseio-shared/api/openapi.yaml`. Change the contract first, then the code.

- Stack: Node 24, TypeScript, Hono, pg, Zod. pnpm only. Exact versions in package.json.
- Green gate: `pnpm build`.
- `src/generated/` comes from `../proseio-shared` (`pnpm gen`). Never edit it. Handle rules and normalisation live in proseio-shared and must match its test vectors.
- Runs on the dev node in Docker Compose (`../proseio-infra/compose`, service `api`, host `api.proseio.com.br`). Postgres database `proseio` on the shared Postgres.
- MAS admin API: client_credentials with scope `urn:mas:admin`. The client ID and secret come from `.env` on the node; never log or print them. MAS cannot delete users: a failed sign-up deactivates the MAS user and refunds the invite use.
- Never log request bodies, emails, passwords, tokens or invite codes. Invite codes are stored only as SHA-256 hashes.
- Rate limits are in memory: one instance only.
- Admin CLI (in the container): `node dist/cli.js invite create --uses 10 --days 12 --note amigos`, `invite list`, `invite revoke <id>`.
- Write docs in ASD-STE100 style.
