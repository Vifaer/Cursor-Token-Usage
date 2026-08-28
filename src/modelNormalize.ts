import { ModelAgg, UsageEvent } from "./models";

/** Cursor aggregations use modelIntent labels; events may use slugs — keep raw strings for filtering. */
export function modelFamilyKey(model: string): string {
  const m = model.trim().toLowerCase();
  if (!m || m === "unknown") return "unknown";
  if (m === "default" || m === "auto") return "__auto__";

  let base = m
    .replace(/\s+/g, "-")
    .replace(/-high-thinking|-medium-thinking|-low-thinking|-thinking/g, "")
    .replace(/-fast$/g, "");

  base = base.replace(/^composer-2-5/, "composer-2.5");
  return base;
}

export function isAutoModelIntent(model: string): boolean {
  return modelFamilyKey(model) === "__auto__";
}

export type ModelModeKey =
  | "standard"
  | "fast"
  | "high"
  | "high-fast"
  | "high-thinking"
  | "medium-thinking"
  | "low-thinking";

/** Extract mode from raw model id/intent (before family stripping). */
export function modelVariantMode(rawModel: string): ModelModeKey {
  const m = rawModel.trim().toLowerCase().replace(/\s+/g, "-");
  const hasFast = /(?:^|-)fast(?:$|-)/.test(m) || /\sfast$/i.test(rawModel);
  if (/high-thinking/.test(m)) return "high-thinking";
  if (/medium-thinking/.test(m)) return "medium-thinking";
  if (/low-thinking/.test(m)) return "low-thinking";
  if (/high/.test(m) && hasFast) return "high-fast";
  if (/high/.test(m)) return "high";
  if (hasFast) return "fast";
  return "standard";
}

const MODE_L10N: Record<ModelModeKey, string> = {
  standard: "Model mode standard",
  fast: "Model mode fast",
  high: "Model mode high",
  "high-fast": "Model mode high-fast",
  "high-thinking": "Model mode high-thinking",
  "medium-thinking": "Model mode medium-thinking",
  "low-thinking": "Model mode low-thinking",
};

export function modelModeL10nKey(mode: ModelModeKey): string {
  return MODE_L10N[mode];
}

export function resolveEventSlugs(aggModel: string, events: UsageEvent[]): string[] {
  const family = modelFamilyKey(aggModel);
  const mode = modelVariantMode(aggModel);
  const slugs = events
    .filter((e) => modelFamilyKey(e.model) === family && modelVariantMode(e.model) === mode)
    .map((e) => e.model);
  if (slugs.length) return [...new Set(slugs)];
  const exact = events.filter((e) => e.model === aggModel).map((e) => e.model);
  if (exact.length) return [...new Set(exact)];
  return [aggModel];
}

export function modelFamilyLabel(familyKey: string, variants: ModelAgg[]): string {
  if (familyKey === "__auto__") return "Auto (Default)";
  if (variants.length === 1) return shortenModelLabel(variants[0].model);
  return shortenModelLabel(familyKey);
}

function shortenModelLabel(model: string): string {
  const cleaned = model
    .replace(/-high-thinking|-medium-thinking|-low-thinking|-thinking/g, "")
    .replace(/-fast$/, " Fast");
  return cleaned
    .split("-")
    .map((p) => (p.length <= 3 ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1)))
    .join(" ")
    .slice(0, 48);
}

export interface GroupedModelAgg {
  familyKey: string;
  label: string;
  variants: ModelAgg[];
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  /** @deprecated use filterSlugs — pipe-separated event slugs for trend filter */
  filterModels: string;
  /** Pipe-separated event slugs for whole family */
  filterSlugs: string;
  /** agg model id -> pipe-separated event slugs */
  variantFilterSlugs: Record<string, string>;
}

function joinSlugs(slugs: string[]): string {
  return [...new Set(slugs.filter(Boolean))].join("|");
}

/** Merge aggs that share the same family + variant mode (e.g. Default + Auto → one standard). */
export function mergeVariantsByMode(variants: ModelAgg[]): ModelAgg[] {
  const scored = new Map<string, { agg: ModelAgg; bestModel: string; bestTokens: number }>();
  for (const v of variants) {
    const mode = modelVariantMode(v.model);
    const cur = scored.get(mode);
    if (!cur) {
      scored.set(mode, { agg: { ...v }, bestModel: v.model, bestTokens: v.totalTokens });
      continue;
    }
    cur.agg.inputTokens += v.inputTokens;
    cur.agg.outputTokens += v.outputTokens;
    cur.agg.cacheWriteTokens += v.cacheWriteTokens;
    cur.agg.cacheReadTokens += v.cacheReadTokens;
    cur.agg.totalTokens += v.totalTokens;
    if (v.totalTokens > cur.bestTokens) {
      cur.bestModel = v.model;
      cur.bestTokens = v.totalTokens;
    }
  }
  return [...scored.values()]
    .map(({ agg, bestModel }) => ({ ...agg, model: bestModel }))
    .sort((a, b) => b.totalTokens - a.totalTokens);
}

export function groupModelAggs(aggs: ModelAgg[], events: UsageEvent[] = []): GroupedModelAgg[] {
  const map = new Map<string, ModelAgg[]>();
  for (const a of aggs) {
    const key = modelFamilyKey(a.model);
    const list = map.get(key) ?? [];
    list.push(a);
    map.set(key, list);
  }

  const groups: GroupedModelAgg[] = [];
  for (const [familyKey, rawVariants] of map) {
    const variants = mergeVariantsByMode(rawVariants);
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheWriteTokens = 0;
    let cacheReadTokens = 0;
    let totalTokens = 0;
    const variantFilterSlugs: Record<string, string> = {};
    const allSlugs: string[] = [];

    for (const v of variants) {
      inputTokens += v.inputTokens;
      outputTokens += v.outputTokens;
      cacheWriteTokens += v.cacheWriteTokens;
      cacheReadTokens += v.cacheReadTokens;
      totalTokens += v.totalTokens;
      // Resolve slugs using all raw intents that share this mode
      const mode = modelVariantMode(v.model);
      const modeRaw = rawVariants.filter((r) => modelVariantMode(r.model) === mode);
      const slugs = [...new Set(modeRaw.flatMap((r) => resolveEventSlugs(r.model, events)))];
      variantFilterSlugs[v.model] = joinSlugs(slugs);
      allSlugs.push(...slugs);
    }

    const filterSlugs = joinSlugs(allSlugs);
    groups.push({
      familyKey,
      label: modelFamilyLabel(familyKey, variants),
      variants,
      inputTokens,
      outputTokens,
      cacheWriteTokens,
      cacheReadTokens,
      totalTokens,
      filterModels: variants.map((v) => v.model).join("|"),
      filterSlugs,
      variantFilterSlugs,
    });
  }
  return groups.sort((a, b) => b.totalTokens - a.totalTokens);
}
