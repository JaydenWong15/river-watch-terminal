// Run once: node scripts/build-history.mjs [--refresh]
// Fetches 2016-01-01..2025-12-31 daily river_discharge per town from Open-Meteo (or reuses
// data/raw/*.csv unless --refresh), and writes data/history-summary.json (the only thing the page loads).
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { percentileInc, countWinterEvents, WINTERS } from './logic.mjs';

const root = new URL('../', import.meta.url);
const REFRESH = process.argv.includes('--refresh');
const { towns } = JSON.parse(await readFile(new URL('data/towns.json', root), 'utf8'));
const summaryFile = new URL('data/history-summary.json', root);
const prevCells = existsSync(summaryFile)
  ? Object.fromEntries(JSON.parse(await readFile(summaryFile, 'utf8')).towns.map(t => [t.town, t.cell]))
  : {};
const START = '2016-01-01', END = '2025-12-31';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const out = [];
for (const t of towns) {
  const rawFile = new URL(`data/raw/${t.town}.csv`, root);
  let time, q, cell;
  if (!REFRESH && existsSync(rawFile)) {
    const rows = (await readFile(rawFile, 'utf8')).trim().split('\n').slice(1).map(l => l.split(','));
    time = rows.map(r => r[0]);
    q = rows.map(r => (r[1] === '' ? null : +r[1]));
    cell = prevCells[t.town];
  } else {
    const url = `https://flood-api.open-meteo.com/v1/flood?latitude=${t.point.lat}&longitude=${t.point.lon}` +
      `&daily=river_discharge&start_date=${START}&end_date=${END}&timezone=GMT`;
    const j = await (await fetch(url)).json();
    if (j.error) throw new Error(`${t.town}: ${j.reason}`);
    ({ time, river_discharge: q } = j.daily);
    cell = { lat: j.latitude, lon: j.longitude };
    const csv = 'date,river_discharge_m3s\n' + time.map((d, i) => `${d},${q[i] ?? ''}`).join('\n') + '\n';
    await writeFile(rawFile, csv);
    await sleep(4000);
  }

  const vals = q.filter(v => v !== null && Number.isFinite(v));
  const p95 = percentileInc(vals, 0.95), p99 = percentileInc(vals, 0.99);
  const ev = countWinterEvents(time, q, p99);
  out.push({
    town: t.town, river: t.river,
    cell,
    days: time.length, missing: q.length - vals.length,
    mean: +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2),
    median: +percentileInc(vals, 0.5).toFixed(2),
    p95: +p95.toFixed(2), p99: +p99.toFixed(2),
    max: Math.max(...vals),
    winterEvents: ev.byWinter, eventsTotal: ev.total,
    first4: ev.first4, last4: ev.last4
  });
  console.log(`${t.town.padEnd(19)} days=${time.length} mean=${out.at(-1).mean} median=${out.at(-1).median} p95=${out.at(-1).p95} p99=${out.at(-1).p99} events=${ev.total} (first4 ${ev.first4} / last4 ${ev.last4})`);
}

await writeFile(new URL('data/history-summary.json', root), JSON.stringify({
  source: 'Open-Meteo Flood API (GloFAS v4 seamless), daily river_discharge, m³/s',
  period: `${START} to ${END}`,
  percentileMethod: 'Linear interpolation, same as Excel/Sheets PERCENTILE.INC',
  eventDefinition: 'A run of consecutive days at or above the town 99th percentile, 1 Oct to 31 Mar',
  winters: WINTERS.map(w => w.label),
  computedAt: new Date().toISOString(),
  towns: out
}, null, 2));
console.log('wrote data/history-summary.json');
