const HOUR_MS = 3600_000;

/** Launches per theme within the last hour. */
export class SaturationTracker {
  private readonly hits = new Map<string, number[]>();

  record(themeId: string, at = Date.now()): void {
    const list = this.hits.get(themeId) ?? [];
    list.push(at);
    this.hits.set(themeId, list);
  }

  count(themeId: string, now = Date.now()): number {
    const list = this.hits.get(themeId);
    if (!list) return 0;
    const cutoff = now - HOUR_MS;
    let i = 0;
    while (i < list.length && list[i]! < cutoff) i++;
    if (i > 0) list.splice(0, i);
    if (list.length === 0) this.hits.delete(themeId);
    return list.length;
  }

  top(n = 5, now = Date.now()): Array<{ theme: string; count: number }> {
    return [...this.hits.keys()]
      .map((theme) => ({ theme, count: this.count(theme, now) }))
      .filter((x) => x.count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, n);
  }
}
