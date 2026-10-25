# bipe-api

Invite sign-up and handle directory for Bipe. See `AGENTS.md` and `../bipe-shared/api/openapi.yaml`.

```bash
pnpm install
```

```bash
pnpm build
```

## App Attest policy

Set `APP_ATTEST_ENVIRONMENT` to `production` or `development` and
`APP_ATTEST_APP_IDS` to a comma-separated list of approved `TEAMID.bundleid`
values. Both settings are required. The API stops at startup if either is
missing or invalid. `NODE_ENV=production` also refuses a development policy.

The environment describes the attestation evidence, not the bundle's suffix.
The current TestFlight app uses `992N457T8D.chat.bipe.app.dev` with production
evidence. Keep that ID explicit until the release cutover. A future App Store
ID must be added deliberately; there is no implicit allowlist.

`SIGNUP_ATTEST_REQUIRED=false` still permits a request without a proof. A
supplied proof is always checked against the environment, approved App IDs,
single-use challenge and Apple's pinned certificate root.

## Android Key Attestation policy

Android sends `key_attestation_chain` (bipe#92, `src/key-attest.ts`, no Google
library). The chain must end at one of Google's attestation roots in
`certs/google-key-attestation-roots.pem`, carry the single-use challenge, and
name an app in `ANDROID_ATTEST_PACKAGES` (default `chat.bipe.app`,
`chat.bipe.app.next`, `chat.bipe.app.next.debug`). When
`ANDROID_ATTEST_CERT_DIGESTS` (hex SHA-256 of the signing certificates) is
set, one digest must match. Leave it empty while tester builds use CI debug
keys. A chain that fails one of these checks gets `attestation_invalid`, and
so does a chain with a certificate on Google's revocation list, which the API
loads every 6 hours.

A valid chain makes the phone attested only with a hardware keystore (TEE or
StrongBox), a locked bootloader and boot state `Verified`, or `SelfSigned`
with a key in `ANDROID_ATTEST_BOOT_KEYS` (GrapheneOS, ADR 0043). Without the
revocation list, no phone counts as attested. Otherwise the sign-up goes on as
if no attestation was sent: `SIGNUP_ATTEST_REQUIRED` and company accounts
decide. Rooted phones and custom ROMs keep sign-up.

Run the isolated policy tests:

```bash
pnpm test:attest
```

They use synthetic certificate chains. They cover Android chains (root, chain,
revocation, challenge, package, signing digest, boot state), production/development
separation, team and bundle mismatches, pinned trust, challenge reuse and
expiry, nonce binding, startup validation and optional signup behavior.
They do not prove that a real TestFlight device or Android phone can attest.

## Scheduling calculation

```bash
pnpm test:scheduling
```

`src/scheduling.ts` exports pure `calculateSlots(input)` and `selectAgenda(input, start)` functions. Inputs use the shared contract types and the explicit clock. Public output is `SlotDays`, with free times only. The selector returns an internal agenda recommendation; it neither reserves a slot nor replaces a database exclusion constraint.

The hand-authored cases live in bipe-shared. Its `node tools/gen-test-vectors.mjs` generates `test/fixtures/scheduling.json`, including a source hash. Do not edit the generated snapshot. Shared drift checks verify the copy. API CI runs it under UTC and Pacific/Auckland without Postgres, MAS or cross-repository credentials. The shared README defines the vector format and boundary rules.

Booking storage, fresh-snapshot hold transactions, authorization, rate limits, retention, routes and notifications remain in bipe#318 and its related issues. No scheduling route is live from this calculation module alone.

## Recovery integration tests

Set `BIPE_TEST_DATABASE_URL` to a disposable Postgres database named `bipe_test`, with user `bipe_test`, a password, and a loopback host. Then run:

```bash
pnpm test:integration
```

The suite refuses a production environment, remote hosts, other database or role names, and connection-query overrides. It never uses `DATABASE_URL`. Each test migrates a random schema, checks the actual database identity, and drops only that schema at the end. CI starts its own Postgres 18 service. Fixtures contain no real accounts or messages. The MAS admin client talks to a local HTTP stub; email stays in memory. Tests control the claim clock without waiting 24 hours.

Coverage: invalid factors before PIN attempts, the five-attempt limit across concurrent paths, one-time token redemption, email delay/cancellation/expiry/claim-secret separation, PIN resets, MAS rejection, a dropped MAS response, and caller loss of a committed response.

### Failure and retry boundaries

The suite records these current behaviours for the security review in bipe#215:

- MAS and Postgres do not share a transaction. If MAS changes the password but its response is lost, Postgres rolls back while MAS keeps the new password. Retrying the old recovery token can complete a new rotation.
- After a token recovery commits, the old token cannot replay a response the caller lost. Another recovery path may be needed.
- A completed email access claim can be retried for one hour. Each retry rotates the password and recovery token again; it does not replay the same credentials. The last result wins. The tests describe this boundary; they do not approve it as a new policy.

The stub does not prove that real MAS sessions survive a password change, that real MAS email-owner responses have the expected shape, or that a real phone stores the resulting credentials and restores history. Real-service and device checks stay in bipe#170 and bipe#231.

## Licence and contributing

AGPL-3.0-only, see [LICENSE](LICENSE). Contributions need a DCO sign-off (`git commit -s`): see the [Bipe contributing guide](https://github.com/bipe-chat/.github/blob/main/CONTRIBUTING.md). The Bipe name and logo are not covered by the licence: see [TRADEMARKS.md](https://github.com/bipe-chat/.github/blob/main/TRADEMARKS.md).
