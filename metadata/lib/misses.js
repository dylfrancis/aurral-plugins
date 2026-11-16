// Lookups that found nothing, kept in the data folder for two weeks, so a sweep that meets the
// same album or track again soon doesn't ask again. Every run records them; only sweeps skip them.
import fs from "node:fs/promises";
import path from "node:path";

const FILE = "misses.json";
const KEEP_MS = 14 * 24 * 3600 * 1000;

export async function loadMisses(dataFolder) {
  const file = path.join(dataFolder, FILE);
  const saved = await fs
    .readFile(file, "utf8")
    .then(JSON.parse)
    .catch(() => ({}));
  const now = Date.now();
  const entries = new Map(Object.entries(saved).filter(([, at]) => now - at < KEEP_MS));
  let changed = false;
  return {
    has: (key) => entries.has(key),
    add(key) {
      entries.set(key, Date.now());
      changed = true;
    },
    // Another process may save in between, and the last save wins. That costs only a lookup.
    async save() {
      if (!changed) return;
      await fs.mkdir(dataFolder, { recursive: true });
      const working = `${file}.${process.pid}.tmp`;
      await fs.writeFile(working, JSON.stringify(Object.fromEntries(entries)));
      await fs.rename(working, file);
      changed = false;
    },
  };
}
