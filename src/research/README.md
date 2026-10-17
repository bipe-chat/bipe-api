# Messaging research

Staff research is displayed at `bipe.chat/admin/pesquisa/`.

This repository is public. Keep the editorial record and its sources in the ignored `research-private/` directory or another private store. Never commit research content, company strategy or exports. Unknown means unverified, never unsupported.

The private study captures the Bipe registers and open issue summaries. It does not change release status. Retain source hashes, capture dates and revision IDs. Read issues through `gh issue list --repo bipe-chat/bipe`. A register-only refresh must preserve the issue review date.

Revisit prose after refreshing the register snapshot. Update `reviewed` only after checking external claims again. `reviewAfter` is a manual review date, not an automation.

The shared type declaration is `bipe-shared/api/internal-research.d.ts`. `bipe-shared/tools/gen.mjs` copies it into the API generated folder so Docker builds need no sibling checkout. Change the OpenAPI route contract first.

The API reads `BIPE_RESEARCH_FILE` (default `/run/bipe-research/messaging.json`) only after `StaffGate` succeeds. It sets `private, no-store`. Production mounts the file from Secret `bipe-research`. Keep the Secret outside source control. The website contains only an authenticated interface. Never import the dataset into bipe-web, add a static JSON download, or prerender strategy. JSON and CSV exports are created from data already returned to the signed-in admin.

Validation: API build, `node --test test/research.test.mjs`, private-source reference checks, shared contract and drift checks, and the web build. Scan public source, client assets and the image for private content. Check the production route without credentials after deployment. Deploy the private data and API before the website. Mark the research volume optional so an absent study does not prevent unrelated API routes from starting.

Canonical company strategy remains in Starlings Docs. Analyst priorities do not supersede ADRs, tracker milestones or release gates.
