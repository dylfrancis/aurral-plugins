import fs from "node:fs/promises";
import path from "node:path";
import { findCover } from "./covers.js";
import { addDetails, addReplayGain, clean, embedCover, embedLyrics } from "./edits.js";
import { combinedLoudness, gainFor, measure } from "./loudness.js";
import { findLyrics, hasLrc, saveLrc } from "./lyrics.js";
import { getRelease, isMbid, trackDetails } from "./musicbrainz.js";
import { checkTime, OutOfTime } from "./net.js";
import { inspect, rewrite, UnsupportedFile } from "./tags.js";

export const FEATURES = [
  ["covers", "embed covers"],
  ["lyricsFile", "save lyrics files"],
  ["lyricsEmbed", "embed lyrics"],
  ["details", "add release details"],
  ["clean", "clean tags"],
  ["replayGain", "add ReplayGain"],
];

const isOn = (value) => value === true || value === "true";

export function readOptions(settings = {}) {
  return {
    ...Object.fromEntries(FEATURES.map(([key]) => [key, isOn(settings[key])])),
    replace: isOn(settings.replace),
  };
}

export const enabled = (options) =>
  FEATURES.filter(([key]) => options[key]).map(([, label]) => label);

export const joined = (items) =>
  items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

// Same as the scanner's list in Aurral.
const AUDIO_EXTENSIONS = new Set([
  ".aac",
  ".aiff",
  ".ape",
  ".flac",
  ".m4a",
  ".mp3",
  ".oga",
  ".ogg",
  ".opus",
  ".wav",
  ".wv",
]);
// Aurral's own folders inside the Library, where files come and go.
const INTERNAL_FOLDERS = new Set([
  "_fallback",
  "_flows",
  "_playlists",
  "_staging",
  "aurral-weekly-flow",
]);
const isAudio = (name) => AUDIO_EXTENSIONS.has(path.extname(name).toLowerCase());

export function createRun({ settings, libraryFolder, dataFolder }, deadline) {
  return {
    options: readOptions(settings),
    libraryFolder,
    dataFolder,
    deadline,
    releases: new Map(),
    covers: new Map(),
    finished: new Set(),
    retry: new Set(),
    summary: {
      tracks: 0,
      updated: 0,
      others: 0,
      done: { covers: 0, lyrics: 0, details: 0, cleaned: 0, replayGain: 0 },
      noLyrics: 0,
      skipped: new Map(),
      problems: new Set(),
      left: 0,
    },
  };
}

const skip = (run, reason) =>
  run.summary.skipped.set(reason, (run.summary.skipped.get(reason) ?? 0) + 1);

const NO_WRITE = new Set(["EACCES", "EPERM", "EROFS"]);

function problem(run, filePath, error) {
  const message = NO_WRITE.has(error.code)
    ? "the plugin isn't allowed to write to its folder"
    : error.message;
  run.summary.problems.add(filePath ? `${path.basename(filePath)}: ${message}` : message);
}

// Resolves a track to its file in the Library folder, or the reason it's skipped. Read-only
// folders belong to other apps, like Lidarr, and Aurral never changes them either.
async function checkPath(run, filePath) {
  if (!filePath) return { skip: "with no file" };
  if (!isAudio(filePath)) return { skip: "that aren't audio files" };
  run.root ??= await fs.realpath(run.libraryFolder).catch(() => null);
  if (!run.root) throw new Error(`Can't find the Library folder at ${run.libraryFolder}`);
  const real = await fs.realpath(filePath).catch(() => null);
  if (!real) return { skip: "that are missing" };
  const relative = path.relative(run.root, real);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    return { skip: "outside the Library folder" };
  const folders = relative.split(path.sep).slice(0, -1);
  if (folders.some((name) => name.startsWith(".") || INTERNAL_FOLDERS.has(name)))
    return { skip: "in Aurral's own folders" };
  return { path: real };
}

// A network lookup that fails costs only its own step. The rest of the track
// still gets done, and the schedule tries the track again later.
async function guarded(run, filePath, work) {
  try {
    return await work();
  } catch (error) {
    if (error instanceof OutOfTime) throw error;
    problem(run, null, error);
    run.retry.add(filePath);
    return undefined;
  }
}

function releaseFor(run, mbid) {
  const key = mbid.toLowerCase();
  if (!run.releases.has(key))
    run.releases.set(
      key,
      getRelease(key, run).catch((error) => {
        run.releases.delete(key);
        throw error;
      }),
    );
  return run.releases.get(key);
}

function coverFor(run, folder, info) {
  const key = [folder, info.releaseMbid, info.releaseGroupMbid].join("\0");
  if (!run.covers.has(key))
    run.covers.set(
      key,
      findCover(folder, info, run.deadline).catch((error) => {
        run.covers.delete(key);
        throw error;
      }),
    );
  return run.covers.get(key);
}

function edit(file, info, plan, options) {
  const changes = [];
  if (options.clean && clean(file, info.kind, options)) changes.push("cleaned");
  if (plan.cover && embedCover(file, plan.cover, options.replace)) changes.push("covers");
  if (plan.details && addDetails(file, info.kind, plan.details, options.replace))
    changes.push("details");
  const lyrics = plan.lyrics && (plan.lyrics.synced ?? plan.lyrics.plain);
  if (options.lyricsEmbed && lyrics && embedLyrics(file, lyrics, options.replace))
    changes.push("lyrics");
  if (plan.replayGain && addReplayGain(file, info.kind, plan.replayGain, info.opus))
    changes.push("replayGain");
  return changes;
}

async function processTrack(run, folder, item, replayGain) {
  const { options, deadline } = run;
  const { info } = item;
  const plan = { replayGain };

  if (options.details && isMbid(info.releaseMbid)) {
    const release = await guarded(run, item.path, () => releaseFor(run, info.releaseMbid));
    if (release) plan.details = trackDetails(release, info);
  }
  const cleanDropsCover = options.clean && info.coverTooBig;
  if (options.covers && (!info.hasCover || cleanDropsCover || options.replace))
    plan.cover = await guarded(run, item.path, () => coverFor(run, folder, info));

  const wantsFile = options.lyricsFile && (options.replace || !(await hasLrc(item.path)));
  const wantsEmbed = options.lyricsEmbed && (options.replace || !info.hasLyrics);
  if (wantsFile || wantsEmbed) {
    plan.lyrics = await guarded(run, item.path, () => findLyrics(info, deadline));
    if (plan.lyrics === null) run.summary.noLyrics++;
  }

  checkTime(deadline);
  const changes = await rewrite(item.path, (file) => edit(file, info, plan, options));
  const savedFile =
    wantsFile &&
    Boolean(plan.lyrics?.synced) &&
    (await saveLrc(item.path, plan.lyrics.synced, options.replace));
  if (savedFile && !changes.includes("lyrics")) changes.push("lyrics");
  return changes;
}

const albumKey = (item) => {
  const { info } = item;
  if (isMbid(info.releaseGroupMbid)) return `group:${info.releaseGroupMbid.toLowerCase()}`;
  if (isMbid(info.releaseMbid)) return `release:${info.releaseMbid.toLowerCase()}`;
  if (info.album) return `album:${info.albumArtist}\0${info.album}`;
  return `file:${item.path}`;
};

// Measures every track of each album in the folder that needs ReplayGain. A track that joins an
// album later gets the whole album measured again, so its other tracks get the new album gain.
async function measureAlbums(run, folder, items) {
  const { options, deadline } = run;
  const albums = new Map();
  for (const item of items) {
    const key = albumKey(item);
    albums.set(key, [...(albums.get(key) ?? []), item]);
  }
  const requested = new Set(items.map((item) => item.path));
  const names = await fs.readdir(folder).catch(() => []);
  for (const name of names) {
    const filePath = path.join(folder, name);
    if (name.startsWith(".") || !isAudio(name) || requested.has(filePath)) continue;
    let info;
    try {
      info = inspect(filePath);
    } catch {
      continue;
    }
    const sibling = { path: filePath, info, sibling: true };
    const group = albums.get(albumKey(sibling));
    if (group) group.push(sibling);
  }

  const replayGains = new Map();
  for (const group of albums.values()) {
    const needed =
      options.replace ||
      group.some(
        ({ info }) => !Number.isFinite(info.trackGain) || !Number.isFinite(info.albumGain),
      );
    if (!needed) continue;
    const measured = [];
    for (const member of group) {
      checkTime(deadline, 20_000);
      try {
        measured.push({ member, result: await measure(member.path, deadline) });
      } catch (error) {
        if (error instanceof OutOfTime) throw error;
        problem(run, member.path, error);
      }
    }
    const album =
      measured.length === group.length
        ? gainFor(
            combinedLoudness(measured.map(({ result }) => result.blocks)),
            Math.max(...measured.map(({ result }) => result.peak)),
          )
        : null;
    for (const { member, result } of measured) {
      const track = gainFor(result.integrated, result.peak);
      if (!track) continue;
      replayGains.set(member.path, {
        track,
        album,
        writeTrack: options.replace || !Number.isFinite(member.info.trackGain),
        member,
      });
    }
  }
  return replayGains;
}

function record(run, changes, requested) {
  if (!changes.length) return;
  if (!requested) {
    run.summary.others++;
    return;
  }
  run.summary.updated++;
  for (const change of changes) run.summary.done[change]++;
}

async function processFolder(run, folder, paths) {
  const items = [];
  for (const filePath of paths) {
    try {
      items.push({ path: filePath, info: inspect(filePath) });
    } catch (error) {
      run.finished.add(filePath);
      if (error instanceof UnsupportedFile) skip(run, error.message);
      else problem(run, filePath, error);
    }
  }
  const replayGains = run.options.replayGain ? await measureAlbums(run, folder, items) : new Map();

  for (const item of items) {
    try {
      const changes = await processTrack(run, folder, item, replayGains.get(item.path));
      run.summary.tracks++;
      record(run, changes, true);
    } catch (error) {
      if (error instanceof OutOfTime) throw error;
      problem(run, item.path, error);
    }
    run.finished.add(item.path);
  }
  // Other tracks of the album get the new album gain.
  for (const replayGain of replayGains.values()) {
    if (!replayGain.member.sibling) continue;
    checkTime(run.deadline);
    try {
      const { info } = replayGain.member;
      record(
        run,
        await rewrite(replayGain.member.path, (file) =>
          addReplayGain(file, info.kind, replayGain, info.opus) ? ["replayGain"] : [],
        ),
        false,
      );
    } catch (error) {
      if (error instanceof OutOfTime) throw error;
      problem(run, replayGain.member.path, error);
    }
  }
}

// Works through the files one album folder at a time. Returns the ones it had
// no time left for, and the ones a lookup failed for, as they were given.
export async function processFiles(paths, run) {
  const folders = new Map();
  const original = new Map();
  for (const filePath of new Set(paths)) {
    const checked = await checkPath(run, filePath);
    if (checked.skip) {
      skip(run, checked.skip);
      continue;
    }
    original.set(checked.path, filePath);
    const folder = path.dirname(checked.path);
    folders.set(folder, [...(folders.get(folder) ?? []), checked.path]);
  }
  for (const [folder, files] of folders) {
    try {
      checkTime(run.deadline, 60_000);
      await processFolder(run, folder, files);
    } catch (error) {
      if (!(error instanceof OutOfTime)) throw error;
      break;
    }
  }
  const given = (keep) => [...original].filter(([real]) => keep(real)).map(([, path]) => path);
  const left = given((real) => !run.finished.has(real));
  run.summary.left = left.length;
  return { left, retry: given((real) => run.finished.has(real) && run.retry.has(real)) };
}

const count = (number, noun) => `${number} ${noun}${number === 1 ? "" : "s"}`;

export function describe(summary) {
  const { done } = summary;
  const parts = [];
  const what = [
    done.covers && count(done.covers, "cover"),
    done.lyrics && `lyrics for ${done.lyrics}`,
    done.details && `release details on ${done.details}`,
    done.cleaned && `${done.cleaned} cleaned`,
    done.replayGain && `ReplayGain on ${done.replayGain}`,
  ].filter(Boolean);
  if (summary.updated)
    parts.push(`Updated ${summary.updated} of ${count(summary.tracks, "track")}: ${joined(what)}.`);
  else if (summary.tracks) parts.push(`Nothing to change on ${count(summary.tracks, "track")}.`);
  if (summary.others)
    parts.push(`Updated the album gain on ${count(summary.others, "other track")}.`);
  if (summary.noLyrics) parts.push(`LRCLIB had no lyrics for ${summary.noLyrics}.`);
  for (const [reason, number] of summary.skipped)
    parts.push(`Skipped ${count(number, "track")} ${reason}.`);
  if (summary.left)
    parts.push(
      `Ran out of time with ${count(summary.left, "track")} left. Run it again for the rest.`,
    );
  const problems = [...summary.problems];
  if (problems.length)
    parts.push(
      `${problems.slice(0, 2).join(". ")}.${problems.length > 2 ? ` And ${problems.length - 2} more problems.` : ""}`,
    );
  return parts.join(" ") || "Nothing to do.";
}
