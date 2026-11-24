// History helpers shared by build-history and tests.
export function percentileInc(values, p) {
  const s = [...values].sort((a, b) => a - b);
  const r = p * (s.length - 1);
  const lo = Math.floor(r), hi = Math.ceil(r);
  return s[lo] + (s[hi] - s[lo]) * (r - lo);
}

export const WINTERS = Array.from({ length: 9 }, (_, i) => {
  const y = 2016 + i;
  return { label: `${y}/${String(y + 1).slice(2)}`, from: `${y}-10-01`, to: `${y + 1}-03-31` };
});

export function countWinterEvents(dates, values, threshold) {
  const byWinter = {};
  for (const w of WINTERS) {
    let n = 0, prevHigh = false;
    for (let i = 0; i < dates.length; i++) {
      const d = dates[i];
      if (d < w.from || d > w.to) continue;
      const high = values[i] !== null && values[i] >= threshold;
      if (high && !prevHigh) n++;
      prevHigh = high;
    }
    byWinter[w.label] = n;
  }
  const v = WINTERS.map(w => byWinter[w.label]);
  return {
    byWinter,
    total: v.reduce((a, b) => a + b, 0),
    first4: v.slice(0, 4).reduce((a, b) => a + b, 0),
    last4: v.slice(5).reduce((a, b) => a + b, 0)
  };
}
