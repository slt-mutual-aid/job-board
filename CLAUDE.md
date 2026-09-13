# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
yarn dev          # Dev server at localhost:4321
yarn build        # Production build
yarn preview      # Preview production build
yarn test         # Run tests (Vitest)
yarn test:ui      # Tests with interactive UI
yarn typecheck    # Type-check the project (runs in CI)

# Updating job data
yarn fetch-csv    # Download latest CSV from Google Sheets → slt-jobs.csv
yarn import-csv   # Parse slt-jobs.csv → jobboard.json

# Job source adapters
yarn sources:lever # Print the Lever postings for the configured location
yarn sources:bamboohr # Print the BambooHR postings for the configured location
yarn sources:health   # Check every source for a silent failure; exits non-zero on one
```

To run a single test file: `yarn test src/components/JobBoard.test.tsx`

## Architecture

**Data pipeline:** Job data lives in a [Google Spreadsheet](https://docs.google.com/spreadsheets/d/16sDYemc_Sn6gRM-cRiT1sEL1U-GJdhqcqmy_k5Z1M3Y/edit) and flows through:

```
Google Sheets → slt-jobs.csv → jobboard.json → src/lib/db.ts → components
```

`scripts/import-csv.ts` parses the CSV (9 columns, no header row — columns are hardcoded), validates required fields, converts MM/DD/YYYY dates to ISO 8601, and writes `jobboard.json`. Unknown/missing dates use `1970-01-01T00:00:00.000Z` as a sentinel value — `isUnknownDate()` in `db.ts` detects these and sorts them to the end.

**Rendering:** `src/pages/index.astro` calls `getAllJobs()` server-side and passes the full job list as a prop to `<JobBoard client:load>`. All search/filter logic runs client-side in React — no server queries after initial load.

**Key files:**

- `src/lib/db.ts` — `Job` interface, `getAllJobs()`, `getJobById()`, `searchJobs()`
- `src/components/JobBoard.tsx` — stateful root React component; owns `searchQuery`, `jobTypeFilter`, `selectedJob`
- `jobboard.json` — generated file, source of truth for job data at runtime
- `slt-jobs.csv` — fetched from Google Sheets, input to import script

**Job source review state:** `yarn sources:lever:review` writes the postings a reviewer has not decided about to `review/new-jobs.csv`, and records in `scripts/data/sources-state.json` which postings already carry a decision. A decision typed into the `Decision` column is read back on the next run, and the posting then leaves the review file. Both paths are gitignored per-machine state: deleting `scripts/data/sources-state.json` proposes every posting again.

**Source health history:** `yarn sources:health` reads the listing of every source in `scripts/sources/registry.ts` and exits non-zero when one returns nothing, or nothing it can confirm as genuinely empty. `.github/workflows/source-health.yml` runs the check on a schedule and pushes the result. `scripts/data/source-health.json` holds the per-source count history and **is committed**: the suspicious-zero and drop rules compare a run against the previous run, so a history that never leaves one machine leaves both rules dormant in CI. Commit it with any change it carries rather than reverting it.

## Deployment

Deployed to GitHub Pages at `https://slt-mutual-aid.github.io/` (configured in `astro.config.mjs`).

## Contributor Workflow: Updating Jobs

> This section is for contributors who are not @treymo. All job updates require a PR review from Trey before merging.

When a contributor asks to "update the jobs" or similar, follow these steps exactly:

**Step 1 — Import the latest data:**

```bash
yarn fetch-csv && yarn import-csv
```

**Step 2 — Verify with the contributor:**
Ask them to open `jobboard.json` and confirm they can see the new/updated jobs they expected. Wait for their confirmation before proceeding.

**Step 3 — Confirm they're ready to open a PR:**
Ask: "Does everything look correct? Ready to open a PR?"

**Step 4 — Branch, commit, push, and open a PR:**

If they have the `gh` CLI set up:

```bash
git checkout -b update-jobs-$(date +%Y-%m-%d)
git add slt-jobs.csv jobboard.json
git commit -m "update jobs $(date +'%b %-d')"
git push -u origin HEAD
gh pr create --title "Update jobs $(date +'%b %-d')" --body "Routine job data update from Google Sheets."
```

If they do **not** have `gh` CLI, note that they should look into setting it up (https://cli.github.com), but they can also do it manually:

```bash
git checkout -b update-jobs-$(date +%Y-%m-%d)
git add slt-jobs.csv jobboard.json
git commit -m "update jobs $(date +'%b %-d')"
git push -u origin HEAD
```

Then open a PR manually at: https://github.com/slt-mutual-aid/job-board/compare

**Step 5 — Tell them to reach out to Trey:**
Let the contributor know the PR is open and they should reach out to Trey ([@treymo](https://github.com/treymo)) to request a review.
