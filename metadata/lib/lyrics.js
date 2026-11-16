import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { request } from "./net.js";

const API = "https://lrclib.net/api";
const DURATION_SLACK_SECONDS = 3;

const simple = (text) =>
  String(text ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "");

async function get(pathAndQuery, deadline) {
  const response = await request(`${API}${pathAndQuery}`, { deadline, service: "LRCLIB" });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`LRCLIB answered ${response.status}`);
  return response.json();
}

const hasLyrics = (entry) =>
  entry && !entry.instrumental && (entry.syncedLyrics || entry.plainLyrics);

// Looks a track up by its exact tags first, then searches and takes a result
// with the same title and about the same length.
export async function findLyrics({ artist, title, album, durationMs }, deadline) {
  if (!artist || !title) return null;
  const seconds = durationMs ? Math.round(durationMs / 1000) : null;
  const exact = new URLSearchParams({ artist_name: artist, track_name: title });
  if (album) exact.set("album_name", album);
  if (seconds) exact.set("duration", String(seconds));
  let found = await get(`/get?${exact}`, deadline);
  if (found?.instrumental) return null;

  if (!hasLyrics(found)) {
    const search = new URLSearchParams({ artist_name: artist, track_name: title });
    const results = (await get(`/search?${search}`, deadline)) ?? [];
    const candidates = (Array.isArray(results) ? results : []).filter(
      (entry) =>
        hasLyrics(entry) &&
        simple(entry.trackName) === simple(title) &&
        (!seconds || Math.abs(Number(entry.duration) - seconds) <= DURATION_SLACK_SECONDS),
    );
    found = candidates.find((entry) => entry.syncedLyrics) ?? candidates[0] ?? null;
  }
  if (!hasLyrics(found)) return null;
  const synced = found.syncedLyrics?.trim() || null;
  return {
    synced,
    plain: found.plainLyrics?.trim() || null,
  };
}

export const lrcPath = (audioPath) =>
  `${audioPath.slice(0, audioPath.length - path.extname(audioPath).length)}.lrc`;

export async function hasLrc(audioPath) {
  return (await fs.stat(lrcPath(audioPath)).catch(() => null))?.isFile() === true;
}

// Aurral reads an .lrc file before a track's own lyrics, and moves and deletes it with the track.
// Returns whether it saved the file, or in a dry run whether it would have.
export async function saveLrc(audioPath, synced, { replace, dryRun }) {
  const target = lrcPath(audioPath);
  const current = await fs.readFile(target, "utf8").catch(() => null);
  if (current !== null && (!replace || current.trim() === synced.trim())) return false;
  if (dryRun) return true;
  const working = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}`);
  await fs.writeFile(working, `${synced.trim()}\n`);
  await fs.rename(working, target);
  return true;
}
