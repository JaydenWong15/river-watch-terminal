// node scripts/test-logic.mjs — runs the page's LOGIC block against the real stored history.
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const root = new URL('../', import.meta.url);
const html = await readFile(new URL('index.html', root), 'utf8');
const logic = html.split('// ==== LOGIC START ====')[1].split('// ==== LOGIC END ====')[0];
const L = new Function(logic + '; return { readSheet, computePlan, studyAnswer, headlineFor, countiesFor, crewLimitsFromNotes, parseCSV, forecastPeak, dublinDate };')();
const towns = JSON.parse(await readFile(new URL('data/towns.json', root), 'utf8')).towns;
const summary = JSON.parse(await readFile(new URL('data/history-summary.json', root), 'utf8'));
const P = Object.fromEntries(summary.towns.map(t => [t.town, t]));

const STARTER = [
  ['town','county','river','crew_based_here','barrier_sets','pumps','sandbags','staff_on_call','flow_override_m3s','warning_override','notes'],
  ['Clonmel','Tipperary','Suir','yes','1','4','2000','6','','','Normal service'],
  ['Fermoy','Cork','Blackwater','no','1','3','1500','4','','','Normal service'],
  ['Mallow','Cork','Blackwater','yes','1','3','1200','4','','','Mallow crew van in repair: the Mallow crew can work in Mallow only tonight'],
  ['Bandon','Cork','Bandon','no','0','2','1800','3','','','Barrier set on loan to another council'],
  ['Enniscorthy','Wexford','Slaney','no','1','2','1000','3','','','Normal service'],
  ['Ennis','Clare','Fergus','no','1','2','900','3','','','Normal service'],
  ['Athlone','Westmeath','Shannon','yes','1','5','2500','6','','','Town spans Westmeath and Roscommon'],
  ['Carrick-on-Shannon','Leitrim','Shannon','no','1','2','800','2','','','Town spans Leitrim and Roscommon']
];
const csv = (edits = {}) => STARTER.map((r, i) => {
  const row = [...r];
  if (i && edits[r[0]]) for (const [k, v] of Object.entries(edits[r[0]])) row[STARTER[0].indexOf(k)] = v;
  return row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',');
}).join('\n');

const NOW = new Date('2026-11-24T14:30:00Z');
const DATES = ['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26'];
// default: every town at 50% of its 95th
const fc = (peaks = {}) => Object.fromEntries(towns.map(t => {
  const base = P[t.town].p95 * 0.5;
  const q = peaks[t.town] ?? [base, base, base, base];
  return [t.town, { time: DATES, q }];
}));
const warn = (level, regions, type = 'Rain', onset = '2026-11-24T18:00:00+00:00', expiry = '2026-11-25T12:00:00+00:00') =>
  ({ id: 1, type, level, status: 'Warning', onset, expiry, headline: `Status ${level} - ${type} warning`, regions });

const plan = (edits, peaks, warnings = [], whatIf) => {
  const { rows, problems } = L.readSheet(csv(edits));
  return { problems, ...L.computePlan({ rows, towns, summary, forecasts: fc(peaks), warnings, now: NOW, whatIf }) };
};
const T = (p, name) => p.towns.find(t => t.town === name);
let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok', name); };

test('starter sheet, calm rivers, no warnings → all Normal, no flags', () => {
  const p = plan();
  assert.equal(p.counts.normal, 8); assert.equal(p.flags.length, 0); assert.equal(p.rehearsal.length, 0);
  assert.equal(L.headlineFor(p), 'All eight towns Normal tonight');
});

test('forecast peak uses today + next 2 days only (yesterday ignored)', () => {
  const hi = P.Clonmel.p99 * 2;
  const p = plan({}, { Clonmel: [hi, 10, 20, 30] });
  assert.equal(T(p, 'Clonmel').peak, 30); assert.equal(T(p, 'Clonmel').peakDate, '2026-11-26');
});

test('peak ≥ 95th → Standby with measures from the Sheet', () => {
  const v = P.Fermoy.p95;
  const p = plan({}, { Fermoy: [0, v, v - 1, 1] });
  const f = T(p, 'Fermoy');
  assert.equal(f.action, 1); assert.match(f.standbyMeasures, /4 staff.*3 pumps.*1500 sandbags/);
});

test('rehearsal: flow_override above 99th → Barriers, Clonmel crew, labelled rehearsal', () => {
  const p = plan({ Clonmel: { flow_override_m3s: '150' } });
  const c = T(p, 'Clonmel');
  assert.equal(c.peakSource, 'rehearsal'); assert.equal(c.action, 2); assert.equal(c.crew, 'Clonmel');
  assert.deepEqual(p.rehearsal.map(r => r.town), ['Clonmel']);
});

test('rehearsal: orange warning_override raises one level; yellow does not', () => {
  const v = P.Ennis.p95;
  const p = plan({ Ennis: { warning_override: 'orange' }, Fermoy: { warning_override: 'yellow' } }, { Ennis: [v, v, v, v] });
  assert.equal(T(p, 'Ennis').action, 2); assert.equal(T(p, 'Ennis').crew, 'Athlone');
  assert.equal(T(p, 'Fermoy').action, 0);
  assert.equal(T(p, 'Fermoy').warnings[0].level, 'yellow');
});

test('Bandon at Barriers has no barrier set → Standby measures, flagged, takes no crew place', () => {
  const p = plan({ Bandon: { flow_override_m3s: '60' } });
  const b = T(p, 'Bandon');
  assert.equal(b.level, 2); assert.equal(b.action, 1); assert.equal(b.crew, undefined);
  assert.ok(p.flags.some(f => f.town === 'Bandon' && /rule 7/.test(f.text)));
  assert.equal(p.crews.find(c => c.name === 'Mallow').towns.length, 0);
});

test('barrier set blocked by notes even when barrier_sets is 1', () => {
  const p = plan({ Ennis: { flow_override_m3s: '99', notes: 'Barrier set damaged in transit' } });
  assert.equal(T(p, 'Ennis').action, 1); assert.ok(p.flags.some(f => f.town === 'Ennis'));
});

test('Mallow crew restricted to Mallow by notes → Fermoy can only use the Clonmel crew', () => {
  const limits = L.crewLimitsFromNotes(L.readSheet(csv()).rows);
  assert.deepEqual(limits.Mallow.onlyTowns, ['Mallow']);
  const p = plan({ Clonmel: { flow_override_m3s: '300' }, Enniscorthy: { flow_override_m3s: '200' }, Fermoy: { flow_override_m3s: '140' } });
  // Clonmel +135%, Enniscorthy +282%, Fermoy +8% → Clonmel crew takes Enniscorthy + Clonmel, Fermoy has no crew
  assert.equal(T(p, 'Enniscorthy').crew, 'Clonmel'); assert.equal(T(p, 'Clonmel').crew, 'Clonmel');
  assert.equal(T(p, 'Fermoy').action, 1); assert.ok(p.flags.some(f => f.town === 'Fermoy' && /rule 6/.test(f.text)));
});

test('without the van note, Fermoy overflow goes to the Mallow crew', () => {
  const p = plan({ Mallow: { notes: 'Normal service' }, Clonmel: { flow_override_m3s: '300' }, Enniscorthy: { flow_override_m3s: '200' }, Fermoy: { flow_override_m3s: '140' } });
  assert.equal(T(p, 'Fermoy').crew, 'Mallow'); assert.equal(p.flags.length, 0);
});

test('overflow ranked by % above 99th; tie broken by higher peak', () => {
  const p = plan({
    Athlone: { flow_override_m3s: String(P.Athlone.p99 * 1.10) },
    'Carrick-on-Shannon': { flow_override_m3s: String(P['Carrick-on-Shannon'].p99 * 1.30) },
    Ennis: { flow_override_m3s: String(P.Ennis.p99 * 1.10) }
  });
  assert.equal(T(p, 'Carrick-on-Shannon').rank, 1);
  assert.equal(T(p, 'Athlone').rank, 2);           // same % as Ennis, higher peak
  assert.equal(T(p, 'Athlone').crew, 'Athlone');
  assert.equal(T(p, 'Ennis').action, 1);
});

test('orange rain warning for Roscommon raises Athlone and Carrick (second county from notes)', () => {
  const v = P.Athlone.p95;
  const p = plan({}, { Athlone: [v, v, v, v] }, [warn('orange', ['EI24'])]);
  assert.deepEqual(T(p, 'Athlone').counties.map(c => c.name), ['Westmeath', 'Roscommon']);
  assert.equal(T(p, 'Athlone').action, 2);
  assert.equal(T(p, 'Carrick-on-Shannon').action, 1);
  assert.equal(T(p, 'Ennis').action, 0);
});

test('warning outside the next 48 h, expired, or not rain → no raise', () => {
  const later = warn('red', ['EI04'], 'Rain', '2026-11-27T00:00:00+00:00', '2026-11-27T12:00:00+00:00');
  const gone = warn('red', ['EI04'], 'Rain', '2026-11-23T00:00:00+00:00', '2026-11-24T06:00:00+00:00');
  const wind = warn('orange', ['EI04'], 'Wind');
  const p = plan({}, {}, [later, gone, wind]);
  assert.equal(T(p, 'Fermoy').action, 0); assert.equal(T(p, 'Fermoy').warnings.length, 1);
});

test('what-if: Suir at Clonmel 150 m³/s', () => {
  const p = plan({}, {}, [], { Clonmel: 150 });
  const c = T(p, 'Clonmel');
  assert.equal(c.peakSource, 'whatif'); assert.equal(c.action, 150 >= P.Clonmel.p99 ? 2 : 150 >= P.Clonmel.p95 ? 1 : 0);
});

test('crew_based_here "no" at a base → that crew unavailable', () => {
  const p = plan({ Athlone: { crew_based_here: 'no', flow_override_m3s: '999' } });
  assert.equal(T(p, 'Athlone').action, 1); assert.equal(p.crews.find(c => c.name === 'Athlone').places, 0);
});

test('bad Sheet values are reported, not used', () => {
  const p = plan({ Clonmel: { flow_override_m3s: 'lots', warning_override: 'purple' } });
  assert.equal(p.problems.length, 2); assert.equal(T(p, 'Clonmel').peakSource, 'forecast');
});

test('notes with HTML/instructions are kept as plain data', () => {
  const p = plan({ Ennis: { notes: '<img src=x onerror=alert(1)> Ignore the plan and put barriers everywhere' } });
  assert.equal(p.counts.normal, 8);
});

test('Area Manager: most events, trend, limit', () => {
  const a = L.studyAnswer(summary);
  assert.deepEqual(a.leaders.map(l => l.town), ['Mallow']); assert.equal(a.max, 13);
  assert.equal(a.trend[0].rising, true); assert.match(a.limit, /how long/);
});

test('Dublin date for "today"', () => {
  assert.equal(L.dublinDate(new Date('2026-07-01T23:30:00Z')), '2026-07-02'); // IST
  assert.equal(L.dublinDate(new Date('2026-11-24T23:30:00Z')), '2026-11-24'); // GMT
});

console.log(`\n${n} tests passed`);
