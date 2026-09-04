import * as vscode from "vscode";
import { readStateDbValue } from "./credentials";
import {
  LEGACY_ACCOUNTS_KEY,
  mergePersistedSnapshots,
  parseLegacyAccounts,
  PersistedSnapshot,
} from "./migrateLegacyPure";

export { mergePersistedSnapshots, parseLegacyAccounts } from "./migrateLegacyPure";

const VIEW_SCOPE_KEY = "cursorTokenUsage.viewScope.v1";
const MIGRATION_FLAG = "cursorTokenUsage.migratedLegacyStores.v1";

/** Other publishers that historically stored the same accounts map. */
const LEGACY_EXTENSION_KEYS = ["akitogo.cursor-token-usage"];

export type LegacyImportResult = {
  imported: number;
  skipped: number;
  sources: string[];
  totalAccounts: number;
};

/**
 * Merge akitogo (and other legacy) account history into the current extension store.
 * Keeps newer fields per account; unions events/dailyBuckets.
 */
export async function importLegacyAccountStores(
  globalState: vscode.Memento,
  opts?: { force?: boolean },
): Promise<LegacyImportResult> {
  if (!opts?.force && globalState.get<boolean>(MIGRATION_FLAG)) {
    const current = globalState.get<Record<string, PersistedSnapshot>>(LEGACY_ACCOUNTS_KEY, {}) ?? {};
    return { imported: 0, skipped: 0, sources: [], totalAccounts: Object.keys(current).length };
  }

  const current = { ...(globalState.get<Record<string, PersistedSnapshot>>(LEGACY_ACCOUNTS_KEY, {}) ?? {}) };
  let imported = 0;
  let skipped = 0;
  const sources: string[] = [];

  for (const key of LEGACY_EXTENSION_KEYS) {
    const raw = await readStateDbValue(key);
    const legacy = parseLegacyAccounts(raw);
    if (Object.keys(legacy).length === 0) continue;
    sources.push(key);
    for (const [uid, snap] of Object.entries(legacy)) {
      const prev = current[uid];
      if (!prev) {
        current[uid] = snap;
        imported++;
        continue;
      }
      const merged = mergePersistedSnapshots(prev, snap);
      const changed =
        merged.updatedAt !== prev.updatedAt ||
        (merged.events?.length ?? 0) !== (prev.events?.length ?? 0) ||
        (merged.totalTokens ?? 0) !== (prev.totalTokens ?? 0);
      if (changed) {
        current[uid] = merged;
        imported++;
      } else {
        skipped++;
      }
    }
  }

  await globalState.update(LEGACY_ACCOUNTS_KEY, current);
  if (!globalState.get(VIEW_SCOPE_KEY)) {
    await globalState.update(VIEW_SCOPE_KEY, "all");
  }
  await globalState.update(MIGRATION_FLAG, true);

  return {
    imported,
    skipped,
    sources,
    totalAccounts: Object.keys(current).length,
  };
}

export async function resetLegacyImportFlag(globalState: vscode.Memento): Promise<void> {
  await globalState.update(MIGRATION_FLAG, undefined);
}
