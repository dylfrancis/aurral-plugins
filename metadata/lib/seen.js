// What the plugin has handled: each file's size and modified time after its last changes, under
// the plugin version and settings it used. The nightly sweep skips a file that still matches.
import fs from "node:fs/promises";
import path from "node:path";

const FILE = "seen.json";
const SAVE_EVERY_MS = 60_000;

export const signature = (stat) => `${stat.size}:${Math.trunc(stat.mtimeMs)}`;

const read = (file) =>
  fs
    .readFile(file, "utf8")
    .then(JSON.parse)
    .catch(() => null);

const filesOf = (saved, fingerprint) =>
  new Map(saved?.fingerprint === fingerprint ? Object.entries(saved.files ?? {}) : []);

// Records saved under another version or other settings don't count, so changing either has the
// next sweep look at every file again.
export async function loadSeen(dataFolder, fingerprint) {
  const file = path.join(dataFolder, FILE);
  const files = filesOf(await read(file), fingerprint);
  const changes = new Map();
  let savedAt = Date.now();
  const seen = {
    matches: (key, value) => files.get(key) === value,
    set(key, value) {
      files.set(key, value);
      changes.set(key, value);
    },
    // Forgets the files in folders that are gone.
    keepFolders(folders) {
      for (const key of [...files.keys()]) {
        if (folders.has(path.dirname(key))) continue;
        files.delete(key);
        changes.set(key, null);
      }
    },
    // Another process may have saved in the meantime, so this run's changes go on top of the file.
    async save() {
      if (!changes.size) return;
      const merged = filesOf(await read(file), fingerprint);
      for (const [key, value] of changes) {
        if (value === null) merged.delete(key);
        else merged.set(key, value);
      }
      await fs.mkdir(dataFolder, { recursive: true });
      const working = `${file}.${process.pid}.tmp`;
      await fs.writeFile(
        working,
        JSON.stringify({ fingerprint, files: Object.fromEntries(merged) }),
      );
      await fs.rename(working, file);
      changes.clear();
      savedAt = Date.now();
    },
    async saveNowAndThen() {
      if (Date.now() - savedAt > SAVE_EVERY_MS) await seen.save();
    },
  };
  return seen;
}
