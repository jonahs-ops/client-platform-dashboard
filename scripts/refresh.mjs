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
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
if (!HUBSPOT_TOKEN) throw new Error('Missing HUBSPOT_TOKEN env var');

const LAUNCHCLOUD_API_KEY = process.env.LAUNCHCLOUD_API_KEY;
if (!LAUNCHCLOUD_API_KEY) throw new Error('Missing LAUNCHCLOUD_API_KEY env var');

const LAUNCHCLOUD_PROJECT_ID = 'cmszksryy00002bhlszykd0xa';
const PORTAL_ID = '22616253';
const HASH_FILE = '.last-data-hash';

// Client Pipeline pipeline id. Deals in other pipelines (e.g. legacy
// pre-migration deals) are intentionally excluded from the drilldown, same
// as the KPI rollups.
const CLIENT_PIPELINE_ID = '698625040';

// Deal-to-company association type id for the "Influenced" label (platform
// side of a Client Pipeline deal, as opposed to the primary Client company).
// This is the Deal→Company direction id specifically — HubSpot issues a
// separate id for the inverse (Company→Deal) direction of the same label,
// which is NOT what /associations/deals/companies/batch/read returns.
// Confirmed by Jonah 2026-09-02 against this portal's association settings.
const INFLUENCED_ASSOCIATION_TYPE_ID = 92;

// Raw dealstage -> { display label, bucket } for Client Pipeline. Bucket
// values match what template.html expects (open / closedwon / closedlost).
// Verified against this pipeline's stage config 2026-09-02.
const DEAL_STAGE_META = {
  '1021232141': { label: 'Stage 1: Aware', bucket: 'open' },
  '1247211664': { label: 'Stage 2: Engaged', bucket: 'open' },
  '1021232146': { label: 'Closed Won', bucket: 'closedwon' },
  '1021232147': { label: 'Closed Lost', bucket: 'closedlost' },
};

// Per https://launchcloud.ai/docs: there is no separate CLI. Headless/CI
// clients call the same MCP server as interactive assistants, over HTTP,
// authenticated with a personal API key as a Bearer header instead of the
// interactive OAuth browser flow.
async function deployToLaunchCloud(htmlPath) {
  const transport = new StreamableHTTPClientTransport(
    new URL('https://launchcloud.ai/mcp'),
    { requestInit: { headers: { Authorization: `Bearer ${LAUNCHCLOUD_API_KEY}` } } }
  );
  const client = new Client({ name: 'dashboard-refresh-bot', version: '1.0.0' });
  await client.connect(transport);

  try {
    const createResult = await client.callTool({
      name: 'create_deployment',
      arguments: { projectId: LAUNCHCLOUD_PROJECT_ID, paths: ['index.html'] },
    });
    const payload = JSON.parse(createResult.content[0].text);
    const upload = payload.uploads.find((u) => u.path === 'index.html');
    if (!upload) throw new Error('No signed upload URL returned for index.html');

    const bytes = readFileSync(htmlPath);
    const putRes = await fetch(upload.url, {
      method: 'PUT',
      headers: upload.headers,
      body: bytes,
    });
    if (!putRes.ok) {
      throw new Error(`Upload failed: ${putRes.status} ${await putRes.text()}`);
    }
    console.log(`Deployed. Live at https://${LAUNCHCLOUD_PROJECT_ID}.launchcloud.ai`);
  } finally {
    await client.close();
  }
}

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

// Every deal in the Client Pipeline, portal-wide. One paginated sweep
// instead of 160 per-platform calls.
async function fetchClientPipelineDeals() {
  const results = [];
  let after = undefined;
  do {
    const body = {
      filterGroups: [{ filters: [{ propertyName: 'pipeline', operator: 'EQ', value: CLIENT_PIPELINE_ID }] }],
      properties: ['dealname', 'dealstage', 'amount', 'closedate', 'hubspot_owner_id'],
      limit: 200,
      ...(after ? { after } : {}),
    };
    const res = await fetch('https://api.hubapi.com/crm/v3/objects/deals/search', {
      method: 'POST',
      headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Deal search failed: ${res.status} ${await res.text()}`);
    const json = await res.json();
    results.push(...json.results);
    after = json.paging?.next?.after;
  } while (after);
  return results;
}

// hubspot_owner_id -> "First Last". Owners list is small; one unpaginated
// call is enough in practice, but loop defensively in case that changes.
async function fetchOwnersMap() {
  const owners = new Map();
  let after = undefined;
  do {
    const url = new URL('https://api.hubapi.com/crm/v3/owners');
    url.searchParams.set('limit', '200');
    if (after) url.searchParams.set('after', after);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } });
    if (!res.ok) throw new Error(`Owners fetch failed: ${res.status} ${await res.text()}`);
    const json = await res.json();
    for (const o of json.results) {
      owners.set(String(o.id), `${o.firstName || ''} ${o.lastName || ''}`.trim() || o.email || 'Unknown');
    }
    after = json.paging?.next?.after;
  } while (after);
  return owners;
}

// Batch-read deal->company associations (100 deal ids per call — this is
// the batch/read endpoint, NOT the paginated list endpoint, so the
// after/limit pagination footgun that bit the client-roster pull doesn't
// apply here). Returns dealId -> platformCompanyId, keeping only the
// company on each deal carrying the "Influenced" association type.
async function fetchInfluencedPlatformByDeal(dealIds) {
  const map = new Map();
  const chunkSize = 100;
  for (let i = 0; i < dealIds.length; i += chunkSize) {
    const chunk = dealIds.slice(i, i + chunkSize);
    const res = await fetch('https://api.hubapi.com/crm/v4/associations/deals/companies/batch/read', {
      method: 'POST',
      headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs: chunk.map((id) => ({ id })) }),
    });
    if (!res.ok) throw new Error(`Association batch read failed: ${res.status} ${await res.text()}`);
    const json = await res.json();
    // TEMP DEBUG — remove once INFLUENCED_ASSOCIATION_TYPE_ID is confirmed.
    if (i === 0) {
      console.log('DEBUG first 3 association results:', JSON.stringify((json.results || []).slice(0, 3), null, 2));
    }
    for (const result of json.results || []) {
      const dealId = result.from?.id;
      const influenced = (result.to || []).find((t) =>
        (t.associationTypes || []).some((at) => at.typeId === INFLUENCED_ASSOCIATION_TYPE_ID)
      );
      if (dealId && influenced) map.set(String(dealId), String(influenced.toObjectId));
    }
  }
  return map;
}

// Fetches the full Client Pipeline once, resolves each deal to its
// Influenced platform, and buckets into the shape template.html expects
// per platform company id. Deals with no Influenced company (the known
// association-hygiene gap) are counted and logged, not silently dropped.
async function buildDealsByPlatform() {
  const [deals, owners] = await Promise.all([fetchClientPipelineDeals(), fetchOwnersMap()]);
  const platformByDeal = await fetchInfluencedPlatformByDeal(deals.map((d) => d.id));

  const byPlatform = {};
  let unattributed = 0;
  for (const deal of deals) {
    const platformId = platformByDeal.get(String(deal.id));
    if (!platformId) {
      unattributed += 1;
      continue;
    }
    const meta = DEAL_STAGE_META[deal.properties.dealstage] || { label: deal.properties.dealstage || 'Unknown', bucket: 'open' };
    const record = {
      name: deal.properties.dealname || '(unnamed deal)',
      id: String(deal.id),
      amount: deal.properties.amount != null ? Number(deal.properties.amount) : null,
      closeDate: (deal.properties.closedate || '').slice(0, 10) || null,
      stage: meta.label,
      bucket: meta.bucket,
      ownerId: deal.properties.hubspot_owner_id || null,
      owner: owners.get(String(deal.properties.hubspot_owner_id)) || 'Unassigned',
    };
    (byPlatform[platformId] ||= []).push(record);
  }

  console.log(`Pulled ${deals.length} Client Pipeline deals, ${unattributed} with no Influenced platform association.`);
  return byPlatform;
}

function buildPlatform(company, dealsByPlatform) {
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
    deals: dealsByPlatform[String(company.id)] || [],
  };
}

function sha256(str) {
  return createHash('sha256').update(str).digest('hex');
}

async function main() {
  const [companies, dealsByPlatform] = await Promise.all([fetchRoster(), buildDealsByPlatform()]);
  const platforms = companies
    .map((c) => buildPlatform(c, dealsByPlatform))
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
  await deployToLaunchCloud('dist/index.html');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
