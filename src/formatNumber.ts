/** Pick the largest readable unit (万/亿 or K/M/B) instead of fixed 万-only scaling. */
export function trimScaled(n: number): string {
  if (n >= 100) return n.toFixed(0);
  const s = n.toFixed(1);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

export function formatCompactNumber(n: number, useChineseUnits: boolean): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (useChineseUnits) {
    if (abs >= 1e8) return `${sign}${trimScaled(abs / 1e8)}亿`;
    if (abs >= 1e4) return `${sign}${trimScaled(abs / 1e4)}万`;
    return `${sign}${Math.round(abs)}`;
  }
  if (abs >= 1e9) return `${sign}${trimScaled(abs / 1e9)}B`;
  if (abs >= 1e6) return `${sign}${trimScaled(abs / 1e6)}M`;
  if (abs >= 1e3) return `${sign}${trimScaled(abs / 1e3)}K`;
  return `${sign}${Math.round(abs)}`;
}
