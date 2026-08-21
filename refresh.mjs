#!/usr/bin/env node
// Pulls the current Platform roster from HubSpot using the agreed gate rule,
// merges it with the manually-archived deal-level data, rebuilds index.html
// from template.html, and deploys to LaunchCloud only if anything changed.
//
// Gate rule (per business decision, 2026-08-21):
//   operating_profile is set AND operating_profile != "Client"
//   AND (client_pipeline_total_clients > 0
//        OR client_pipeline_closedwon_deals > 0
//        OR client_pipeline_open_deals > 0)
//
// operating_profile data-quality gaps (blank values, or real platforms
// mistagged "Client") are treated as a CRM hygiene problem to fix at the
// source, not something this script works around.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';

const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
if (!HUBSPOT_TOKEN) throw new Error('Missing HUBSPOT_TOKEN env var');

const LAUNCHCLOUD_PROJECT_ID = 'cmszksryy00002bhlszykd0xa';
const PORTAL_ID = '22616253';
const HASH_FILE = '.last-data-hash';

const STAGE_LABELS = {
  lead: 'Lead', opportunity: 'Opportunity', '1011886144': 'Qualified Opportunity',
  customer: 'Partner', '1054356635': 'Onboarding', '1054320558': 'Impact', '1054356636': 'Growth',
  evangelist: 'Evangelist', '101596044': 'Support', other: 'Other',
  '131822945': 'Disqualified', '131827498': 'Churned', '264913847': 'Dissolved',
};
const PROSPECT_LABELS = new Set(['Lead', 'Opportunity', 'Qualified Opportunity']);
const PARTNER_LABELS = new Set(['Partner', 'Onboarding', 'Impact', 'Growth']);

function bucketStage(label) {
  if (PROSPECT_LABELS.has(label)) return 'Prospect';
  if (PARTNER_LABELS.has(label)) return 'Partner';
  return 'Other';
}

const PROPERTIES = [
  'name', 'company_vertical', 'lifecyclestage',
  'client_pipeline_total_clients', 'client_pipeline_open_deals',
  'client_pipeline_closedwon_deals', 'total_associated_companies',
  'client_pipeline_3plus_cw', 'client_pipeline_recent_activity_clients',
];

// The three OR'd filter groups implementing the gate rule.
function gateFilterGroups() {
  const base = [
    { propertyName: 'operating_profile', operator: 'HAS_PROPERTY' },
    { propertyName: 'operating_profile', operator: 'NEQ', value: 'Client' },
  ];
  return [
    { filters: [...base, { propertyName: 'client_pipeline_total_clients', operator: 'GT', value: '0' }] },
    { filters: [...base, { propertyName: 'client_pipeline_closedwon_deals', operator: 'GT', value: '0' }] },
    { filters: [...base, { propertyName: 'client_pipeline_open_deals', operator: 'GT', value: '0' }] },
  ];
}

async function fetchRoster() {
  const results = [];
  let after = undefined;
  do {
    const body = {
      filterGroups: gateFilterGroups(),
      properties: PROPERTIES,
      limit: 200,
      ...(after ? { after } : {}),
    };
    const res = await fetch('https://api.hubapi.com/crm/v3/objects/companies/search', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${HUBSPOT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`HubSpot search failed: ${res.status} ${await res.text()}`);
    }
    const json = await res.json();
    results.push(...json.results);
    after = json.paging?.next?.after;
  } while (after);
  return results;
}

function buildPlatform(company, dealsArchive) {
  const p = company.properties;
  const tc = Number(p.client_pipeline_total_clients || 0);
  const od = Number(p.client_pipeline_open_deals || 0);
  const cw = Number(p.client_pipeline_closedwon_deals || 0);
  const rac = Number(p.client_pipeline_recent_activity_clients || 0);
  const ta = Number(p.total_associated_companies || 0);
  const stageLabel = STAGE_LABELS[p.lifecyclestage] || p.lifecyclestage || 'Unknown';

  return {
    name: (p.name || '').trim(),
    id: String(company.id),
    vertical: p.company_vertical || 'Unassigned',
    stage: bucketStage(stageLabel),
    stageLabel,
    totalClients: tc,
    openDeals: od,
    closedWon: cw,
    totalAssociated: ta,
    influenced: String(p.client_pipeline_3plus_cw).toLowerCase() === 'true',
    oppRate: tc > 0 ? Math.round((od / tc) * 1000) / 10 : null,
    capRate: tc > 0 ? Math.round((cw / tc) * 1000) / 10 : null,
    recentActivityClients: rac,
    coverage: tc > 0 ? Math.round((rac / tc) * 1000) / 10 : null,
    deals: dealsArchive[String(company.id)] || [],
  };
}

function sha256(str) {
  return createHash('sha256').update(str).digest('hex');
}

async function main() {
  const dealsArchive = JSON.parse(readFileSync('deals_archive.json', 'utf8'));
  const companies = await fetchRoster();
  const platforms = companies
    .map((c) => buildPlatform(c, dealsArchive))
    .sort((a, b) => a.name.localeCompare(b.name));

  const data = {
    portalId: PORTAL_ID,
    generatedAt: new Date().toISOString().slice(0, 10),
    platforms,
  };

  // Hash on platform content only (exclude generatedAt) so a same-data run
  // on a new day doesn't count as "changed".
  const hashInput = JSON.stringify(platforms);
  const newHash = sha256(hashInput);
  const prevHash = existsSync(HASH_FILE) ? readFileSync(HASH_FILE, 'utf8').trim() : null;

  console.log(`Pulled ${platforms.length} platforms. New hash: ${newHash.slice(0, 12)}... Previous: ${prevHash ? prevHash.slice(0, 12) + '...' : '(none)'}`);

  if (newHash === prevHash) {
    console.log('No change since last deploy. Skipping.');
    return;
  }

  const template = readFileSync('template.html', 'utf8');
  const html = template.replace('__DATA_JSON__', JSON.stringify(data));
  writeFileSync('dist/index.html', html);
  writeFileSync(HASH_FILE, newHash);

  console.log('Data changed — deploying to LaunchCloud...');

  // TODO: confirm the exact LaunchCloud CLI auth mechanism (env var / config
  // file / login command) before relying on this in production. The `lc`
  // CLI is referenced in LaunchCloud's docs as:
  //   lc deployments create --project-id <id> <path>
  // but the auth setup step isn't documented here - check your LaunchCloud
  // account settings for an API key, or run `lc --help` once installed.
  execSync(`lc deployments create --project-id ${LAUNCHCLOUD_PROJECT_ID} dist`, {
    stdio: 'inherit',
  });

  console.log('Deployed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
