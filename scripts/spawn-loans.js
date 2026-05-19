/**
 * scripts/spawn-loans.js
 *
 * Spawns 20 loan application actors and distributes them across states.
 * Run after deploying loan-v1.
 *
 * Usage:
 *   SK_API_KEY=sk_live_... node scripts/spawn-loans.js
 *   # or with an .env file:
 *   node --env-file=.env scripts/spawn-loans.js
 *
 * Environment:
 *   SK_API_KEY   — your StateKeep API key (required)
 *   SK_BASE_URL  — override base URL (default: https://statekeep.161-97-163-210.nip.io)
 */

const API_KEY  = process.env.SK_API_KEY || process.env.STATEKEEP_API_KEY;
const BASE_URL = (process.env.SK_BASE_URL || 'https://statekeep.161-97-163-210.nip.io').replace(/\/$/, '');

if (!API_KEY) {
  console.error('Error: SK_API_KEY environment variable is required.');
  console.error('  SK_API_KEY=sk_live_... node scripts/spawn-loans.js');
  process.exit(1);
}

const HEADERS = {
  'x-api-key':    API_KEY,
  'Content-Type': 'application/json',
};

async function api(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: HEADERS,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error || 'API error'), { status: res.status, data });
  return data;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Realistic applicant profiles
const APPLICANTS = [
  { name: 'James Alderton',   amount: 320000, term: '30y', creditScore: 742, region: 'NA' },
  { name: 'Priya Nair',       amount: 185000, term: '15y', creditScore: 698, region: 'EU' },
  { name: 'Carlos Mendes',    amount: 450000, term: '30y', creditScore: 815, region: 'LA' },
  { name: 'Sophie Beaumont',  amount: 275000, term: '20y', creditScore: 661, region: 'EU' },
  { name: 'Kenji Watanabe',   amount: 510000, term: '30y', creditScore: 780, region: 'AP' },
  { name: 'Amara Okonkwo',    amount: 225000, term: '25y', creditScore: 720, region: 'AF' },
  { name: 'Ivan Petrov',      amount: 380000, term: '30y', creditScore: 689, region: 'EU' },
  { name: 'Fatima Al-Hassan', amount: 295000, term: '20y', creditScore: 755, region: 'ME' },
  { name: 'Luca Ferretti',    amount: 160000, term: '15y', creditScore: 634, region: 'EU' },
  { name: 'Nadia Johansson',  amount: 490000, term: '30y', creditScore: 801, region: 'EU' },
  { name: 'Marcus Johnson',   amount: 210000, term: '20y', creditScore: 669, region: 'NA' },
  { name: 'Yuki Tanaka',      amount: 350000, term: '25y', creditScore: 728, region: 'AP' },
  { name: 'Elena Volkov',     amount: 285000, term: '30y', creditScore: 714, region: 'EU' },
  { name: 'Omar Farouk',      amount: 420000, term: '30y', creditScore: 762, region: 'ME' },
  { name: 'Rosa Martinez',    amount: 195000, term: '15y', creditScore: 683, region: 'LA' },
  { name: 'David Osei',       amount: 330000, term: '25y', creditScore: 741, region: 'AF' },
  { name: 'Claire Dubois',    amount: 475000, term: '30y', creditScore: 793, region: 'EU' },
  { name: 'Raj Krishnamurthy', amount: 255000, term: '20y', creditScore: 706, region: 'AP' },
  { name: 'Mia Andersen',     amount: 365000, term: '30y', creditScore: 758, region: 'EU' },
  { name: 'Chen Wei',         amount: 540000, term: '30y', creditScore: 829, region: 'AP' },
];

const UNDERWRITERS = ['uw_north', 'uw_south', 'uw_east', 'uw_west'];

async function api_safe(method, path, body) {
  try {
    return await api(method, path, body);
  } catch (err) {
    if (err.status === 409) return null;
    throw err;
  }
}

async function main() {
  console.log(`\nStateKeep Loan Simulation`);
  console.log(`Base URL:  ${BASE_URL}`);
  console.log(`Spawning 20 loan actors on loan-v1...\n`);

  const actors = [];

  for (let i = 0; i < 20; i++) {
    const p = APPLICANTS[i];
    const actor = await api('POST', '/v1/actors', {
      definitionId:   'loan-v1',
      initialContext: {
        loanId:      `LN-${String(2025000 + i + 1)}`,
        applicant:   p.name,
        amount:      p.amount,
        term:        p.term,
        creditScore: p.creditScore,
        region:      p.region,
        appliedAt:   new Date(Date.now() - (20 - i) * 86400000).toISOString().slice(0, 10),
      },
    });
    actors.push(actor);
    console.log(`[${String(i + 1).padStart(2)}] Spawned  ${actor.id}  state=idle  ${p.name} — $${p.amount.toLocaleString()}`);
    await sleep(150);
  }

  console.log('\n--- Moving actors through states ---\n');

  // All 20 actors: APPLY event (idle → application)
  console.log('Sending APPLY to all 20 actors...');
  for (let i = 0; i < 20; i++) {
    const a   = actors[i];
    const res = await api_safe('POST', `/v1/actors/${a.id}/event`, {
      type:    'APPLY',
      payload: { channel: 'web', ipAddress: `192.168.1.${i + 1}` },
    });
    if (res) process.stdout.write('.');
    await sleep(80);
  }
  console.log('\n');

  // Cohort A (actors 0-2): stay in `application` (form not submitted yet)
  console.log('Cohort A (actors 1-3): staying in application state\n');

  // Cohort B (actors 3-8): SUBMIT → underwriting
  console.log('Cohort B (actors 4-9): SUBMIT → underwriting...');
  for (let i = 3; i <= 8; i++) {
    const a   = actors[i];
    const res = await api_safe('POST', `/v1/actors/${a.id}/event`, {
      type:    'SUBMIT',
      payload: { submittedAt: new Date().toISOString(), docsComplete: true },
    });
    if (res) console.log(`  [${String(i + 1).padStart(2)}] SUBMIT   ${a.id}  state=${res.stateValue}`);
    await sleep(120);
  }
  console.log();

  // Cohort C (actors 9-14): SUBMIT → underwriting → APPROVE → approved
  console.log('Cohort C (actors 10-15): through underwriting...');
  for (let i = 9; i <= 14; i++) {
    const a  = actors[i];
    const uw = UNDERWRITERS[i % UNDERWRITERS.length];

    const r1 = await api_safe('POST', `/v1/actors/${a.id}/event`, {
      type:    'SUBMIT',
      payload: { submittedAt: new Date().toISOString(), docsComplete: true },
    });
    if (r1) console.log(`  [${String(i + 1).padStart(2)}] SUBMIT   ${a.id}  state=${r1.stateValue}`);
    await sleep(100);

    const approved = APPLICANTS[i].creditScore >= 700;
    const r2 = await api_safe('POST', `/v1/actors/${a.id}/event`, {
      type:    approved ? 'APPROVE' : 'REJECT',
      payload: { underwriter: uw, decisionAt: new Date().toISOString(), notes: approved ? 'Clean credit history' : 'Insufficient income' },
    });
    if (r2) console.log(`  [${String(i + 1).padStart(2)}] ${approved ? 'APPROVE' : 'REJECT '}  ${a.id}  state=${r2.stateValue}`);
    await sleep(120);
  }
  console.log();

  // Cohort D (actors 15-17): full approved → active
  console.log('Cohort D (actors 16-18): approve + disburse...');
  for (let i = 15; i <= 17; i++) {
    const a  = actors[i];
    const uw = UNDERWRITERS[i % UNDERWRITERS.length];

    const r1 = await api_safe('POST', `/v1/actors/${a.id}/event`, {
      type:    'SUBMIT',
      payload: { submittedAt: new Date().toISOString() },
    });
    if (r1) console.log(`  [${String(i + 1).padStart(2)}] SUBMIT   ${a.id}  state=${r1.stateValue}`);
    await sleep(100);

    const r2 = await api_safe('POST', `/v1/actors/${a.id}/event`, {
      type:    'APPROVE',
      payload: { underwriter: uw },
    });
    if (r2) console.log(`  [${String(i + 1).padStart(2)}] APPROVE  ${a.id}  state=${r2.stateValue}`);
    await sleep(100);

    const r3 = await api_safe('POST', `/v1/actors/${a.id}/event`, {
      type:    'DISBURSE',
      payload: { disbursedAt: new Date().toISOString(), accountNumber: `ACC-${String(i + 1).padStart(6, '0')}` },
    });
    if (r3) console.log(`  [${String(i + 1).padStart(2)}] DISBURSE ${a.id}  state=${r3.stateValue}`);
    await sleep(120);
  }
  console.log();

  // Cohort E (actors 18-19): full flow → repaid
  console.log('Cohort E (actors 19-20): complete full lifecycle → repaid...');
  for (let i = 18; i <= 19; i++) {
    const a  = actors[i];
    const uw = UNDERWRITERS[i % UNDERWRITERS.length];

    for (const [type, payload] of [
      ['SUBMIT',   { submittedAt: new Date().toISOString() }],
      ['APPROVE',  { underwriter: uw }],
      ['DISBURSE', { disbursedAt: new Date().toISOString() }],
      ['REPAY',    { finalPaymentAt: new Date().toISOString(), totalPaid: APPLICANTS[i].amount * 1.42 }],
    ]) {
      const r = await api_safe('POST', `/v1/actors/${a.id}/event`, { type, payload });
      if (r) console.log(`  [${String(i + 1).padStart(2)}] ${type.padEnd(8)} ${a.id}  state=${r.stateValue}${r.done ? '  ✓ DONE' : ''}`);
      await sleep(100);
    }
  }
  console.log();

  console.log('\n--- Final state distribution (expected) ---\n');
  console.log('  idle          : —  (all actors moved past idle)');
  console.log('  application   : actors 1-3   (3 actors)  ← applied, form not submitted');
  console.log('  underwriting  : actors 4-9   (6 actors)  ← submitted, awaiting decision');
  console.log('  approved      : some of actors 10-15     ← approved, not yet disbursed');
  console.log('  rejected      : some of actors 10-15     ← rejected (credit score < 700)');
  console.log('  active        : actors 16-18 (3 actors)  ← loan disbursed, in repayment');
  console.log('  repaid        : actors 19-20 (2 actors)  ← fully repaid ✓');

  console.log('\n--- Actual final states ---\n');
  const byState = {};
  for (const a of actors) {
    const res = await api('GET', `/v1/actors/${a.id}`);
    const s   = res.stateValue;
    if (!byState[s]) byState[s] = [];
    byState[s].push({ id: a.id, name: APPLICANTS[actors.indexOf(a)].name });
  }
  for (const [state, items] of Object.entries(byState).sort()) {
    console.log(`  ${state.padEnd(15)} (${items.length}): ${items[0].name}${items.length > 1 ? ` ... +${items.length - 1} more` : ''}`);
    console.log(`                    ${items[0].id}`);
  }

  console.log('\nDone. Open the dashboard to see all actors:');
  console.log(`  ${BASE_URL}/dashboard/\n`);
  console.log('Next step: deploy loan-v2 to add income verification (see docs/scenarios/scenario-2-loans.md)\n');
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  if (err.data) console.error('API response:', JSON.stringify(err.data, null, 2));
  process.exit(1);
});
