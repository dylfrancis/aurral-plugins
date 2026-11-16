import fs from "node:fs/promises";
import path from "node:path";
import { ffmpegVersion } from "./lib/loudness.js";
import { claimQueue, enqueue, releaseQueue } from "./lib/queue.js";
import {
  createRun,
  describe,
  enabled,
  finishRun,
  joined,
  processFiles,
  readOptions,
} from "./lib/run.js";
import { sweep } from "./lib/sweep.js";

// A folder is left alone until its downloads have stopped arriving for this
// long, so a whole album is there before its album gain is measured.
const SETTLE_MS = 5 * 60_000;
const MAX_TRIES = 3;
// A folder that time runs out in this often is too big for a scheduled run.
const MAX_CUTS = 3;
const TOO_BIG = "too big to finish in a scheduled run, so it was skipped. Use Fix metadata on it.";
// Aurral gives a scheduled run 10 minutes and a background action 30.
const SCHEDULE_BUDGET_MS = 8.5 * 60_000;
const ACTION_BUDGET_MS = 28 * 60_000;

const NOTHING_ON = "Turn on at least one thing for the plugin to do, like Embed covers.";

async function runAction(input, paths) {
  const run = createRun(input, Date.now() + ACTION_BUDGET_MS);
  if (!enabled(run.options).length) throw new Error(NOTHING_ON);
  try {
    await processFiles(paths, run);
  } finally {
    await finishRun(run);
  }
  return { message: describe(run.summary, { action: true }) };
}

// Works on the downloads whose folders have settled, and puts the rest back in the queue.
async function processDownloads(run, started) {
  const claim = await claimQueue(run.dataFolder);
  const newest = new Map();
  for (const entry of claim.entries) {
    const folder = path.dirname(entry.path);
    newest.set(folder, Math.max(newest.get(folder) ?? 0, entry.at));
  }
  const settled = (entry) => newest.get(path.dirname(entry.path)) <= started - SETTLE_MS;
  const ready = claim.entries.filter(settled);
  const waiting = claim.entries.filter((entry) => !settled(entry));

  // A run that fails keeps every download for the next one.
  let result = { left: ready.map((entry) => entry.path), cutShort: [], retry: [] };
  try {
    if (ready.length)
      result = await processFiles(
        ready.map((entry) => entry.path),
        run,
      );
  } finally {
    const left = new Set(result.left);
    const cutShort = new Set(result.cutShort);
    const retry = new Set(result.retry);
    const kept = ready
      .filter((entry) => left.has(entry.path))
      .map((entry) =>
        cutShort.has(entry.path) ? { ...entry, cuts: (entry.cuts ?? 0) + 1 } : entry,
      );
    const tooBig = new Set(
      kept.filter((entry) => entry.cuts >= MAX_CUTS).map((entry) => path.dirname(entry.path)),
    );
    for (const folder of tooBig) console.log(`${folder}: ${TOO_BIG}`);
    await releaseQueue(run.dataFolder, claim, [
      ...waiting,
      ...kept.filter((entry) => !tooBig.has(path.dirname(entry.path))),
      // A track a lookup failed for waits out the settle time and tries again.
      ...ready
        .filter((entry) => retry.has(entry.path) && (entry.tries ?? 0) + 1 < MAX_TRIES)
        .map((entry) => ({ ...entry, at: Date.now(), tries: (entry.tries ?? 0) + 1 })),
    ]);
  }
}

export default {
  async test({ settings, libraryFolder }) {
    const options = readOptions(settings);
    const doing = enabled(options);
    if (!doing.length) throw new Error(NOTHING_ON);
    await fs.access(libraryFolder, fs.constants.W_OK).catch(() => {
      throw new Error(`The plugin can't write to the Library folder at ${libraryFolder}`);
    });
    let ffmpeg = "";
    if (options.replayGain) {
      const version = await ffmpegVersion();
      if (!version) throw new Error("ReplayGain needs ffmpeg, and the plugin can't find it");
      ffmpeg = ` with ffmpeg ${version}`;
    }
    const notes = [
      options.covers && options.preferDigital && "preferring digital covers",
      options.replace && "replacing what files already have",
      options.sweep && `sweeping the whole library every night from ${options.sweepHour}:00`,
    ].filter(Boolean);
    return {
      message: `${options.dryRun ? "Dry run: would" : "Ready to"} ${joined(doing)}${ffmpeg} in ${libraryFolder}${notes.length ? `, ${joined(notes)}` : ""}.`,
    };
  },

  events: {
    async "download.finished"({ settings, dataFolder, track }) {
      if (!track?.path || !enabled(readOptions(settings)).length) return;
      await enqueue(dataFolder, track.path);
    },
  },

  actions: {
    fixAlbum: (input) =>
      runAction(
        input,
        input.album.tracks.map((track) => track.path),
      ),
    fixTracks: (input) =>
      runAction(
        input,
        input.tracks.map((track) => track.path),
      ),
  },

  // New downloads come first, and the nightly sweep gets the time that's left.
  async scheduled(input) {
    const started = Date.now();
    const run = createRun(input, started + SCHEDULE_BUDGET_MS);
    if (!enabled(run.options).length) {
      await releaseQueue(run.dataFolder, await claimQueue(run.dataFolder), []);
      return;
    }
    try {
      await processDownloads(run, started);
      if (run.options.sweep) await sweep(run);
    } finally {
      await finishRun(run);
    }
    if (run.summary.tracks || run.summary.skipped.size || run.summary.problems.size)
      console.log(describe(run.summary));
  },
};
