# Platform Capture Rate Dashboard — automated refresh

Live at: https://cmszksryy00002bhlszykd0xa.launchcloud.ai

## How this works

- `template.html` — the full dashboard UI (KPI tiles, filters, drill-downs,
  owner cohorting), with `__DATA_JSON__` as a placeholder where the data goes.
- `deals_archive.json` — deal-level records (name, amount, stage, owner) for
  the platforms where we've pulled them. **This is still manually maintained**
  — deal-level data was originally built from a one-time TSV export, not a
  live API pull. Platforms not in this file just show an empty deals list
  (same as several already do today, e.g. Gradelink, QuickSchools.com).
- `scripts/refresh.mjs` — pulls the current roster from HubSpot using the
  gate rule below, merges in `deals_archive.json`, rebuilds `dist/index.html`
  from the template, and deploys to LaunchCloud **only if the data actually
  changed** since the last run (compared via a hash stored in
  `.last-data-hash`).
- `.github/workflows/refresh.yml` — runs the script every 30 minutes across
  the window the nightly HubSpot workflow typically runs in (Saturday evening
  through Monday afternoon, UTC). No manual "refresh" step needed.

## Roster gate rule

A company appears on the dashboard when:

```
operating_profile is set AND operating_profile != "Client"
AND (client_pipeline_total_clients > 0
     OR client_pipeline_closedwon_deals > 0
     OR client_pipeline_open_deals > 0)
```

Known accepted gap: some real platforms currently have `operating_profile`
blank or incorrectly set to "Client" (e.g. Sport Ngin, Crested Butte
Development Team, PraxiSchool, Care.com as of 2026-08-21). Per team decision,
this is treated as a CRM data-quality issue to fix at the source in HubSpot,
not something the refresh script should work around.

## Setup — two things need to be done before this actually runs

### 1. HubSpot Service Key

HubSpot introduced Service Keys in 2026 specifically for data-only,
system-to-system integrations like this one — use one instead of a legacy
Private App (HubSpot's own account setup flow will likely steer you there
already). Create one with at minimum:
- `crm.objects.companies.read`
- `crm.schemas.companies.read`

Service Keys authenticate the same way as Private App tokens
(`Authorization: Bearer <token>`), so no script changes are needed either
way — this is purely about which credential type you generate in HubSpot.

Add the token as a GitHub repo secret named `HUBSPOT_TOKEN`
(Settings → Secrets and variables → Actions).

### 2. LaunchCloud CLI auth — **unconfirmed, needs verification**

The workflow and script both have `TODO` markers where the LaunchCloud CLI
install/login step goes. LaunchCloud's own docs mention a CLI
(`lc deployments create --project-id <id> <path>`) for exactly this kind of
CI use, but the install method and auth mechanism weren't available to
confirm at the time this was built. Before the workflow will actually deploy:

1. Check your LaunchCloud account settings for an API key or CLI login token.
2. Install the CLI locally and run `lc --help` to see the actual auth flow.
3. Update the `TODO` step in `.github/workflows/refresh.yml` accordingly, and
   add whatever secret it needs (placeholder name used here:
   `LAUNCHCLOUD_API_KEY`).

Until that's filled in, the script will pull fresh data and detect changes
correctly, but the final `lc deployments create` call will fail. Worth doing
a manual `workflow_dispatch` run first to confirm the whole pipeline end to
end before trusting the schedule.

## Adjusting the polling window

Once you have a sense of how long the nightly HubSpot workflow actually takes
to clear its enrollment, narrow or widen the cron schedule in
`.github/workflows/refresh.yml` accordingly — no code changes needed
elsewhere.

Once you have a sense of how long the nightly HubSpot workflow actually takes
to clear its enrollment, narrow or widen the cron schedule in
`.github/workflows/refresh.yml` accordingly — no code changes needed
elsewhere.
