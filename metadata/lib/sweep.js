// A nightly pass over the Library that opens only the files new or changed since it last handled
// them. It saves its place, so a library too big for one 10-minute run carries on in the next,
// and one too big for a night carries on the next night.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { albumFolders, audioFiles, changedFiles, processFiles, seenFor } from "./run.js";

const STATE = "sweep.json";
const FOLDER_BUDGET_MS = 60_000;
// A folder time runs out in this often is too big for a scheduled run, and the sweep moves on.
const MAX_CUTS = 3;

const day = (date) =>
  [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part) => String(part).padStart(2, "0"))
    .join("-");

async function readState(dataFolder) {
  return fs
    .readFile(path.join(dataFolder, STATE), "utf8")
    .then(JSON.parse)
    .catch(() => null);
}

async function writeState(dataFolder, state) {
  const file = path.join(dataFolder, STATE);
  const working = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(working, JSON.stringify(state));
  await fs.rename(working, file);
}

// The sweep works from the hour the settings give, in the server's time zone, for this many hours.
export const SWEEP_HOURS = 6;

const inWindow = (startHour, now) => (now.getHours() - startHour + 24) % 24 < SWEEP_HOURS;

// The day the window a time falls in opened, so a window past midnight stays one night.
function nightOf(startHour, now) {
  const opened = new Date(now);
  if (now.getHours() < startHour) opened.setDate(opened.getDate() - 1);
  return day(opened);
}

// A sweep starts once a night, and an unfinished one carries on first. Turning Dry run on or off
// starts a new sweep.
function due(state, options, now) {
  if (!inWindow(options.sweepHour, now)) return null;
  const sameDryRun = state && state.dryRun === options.dryRun;
  if (sameDryRun && state.next < state.folders.length) return "continue";
  if (sameDryRun && state.day === nightOf(options.sweepHour, now)) return null;
  return "start";
}

// Sweeps for as long as the run has time. Returns the sweep's state, or null when none is due.
export async function sweep(run, now = new Date()) {
  run.root ??= await fs.realpath(run.libraryFolder);
  let state = await readState(run.dataFolder);
  const next = due(state, run.options, now);
  if (!next) return null;
  if (next === "start") {
    state = {
      day: nightOf(run.options.sweepHour, now),
      dryRun: run.options.dryRun,
      startedAt: now.getTime(),
      folders: await albumFolders(run),
      next: 0,
    };
    await fs.mkdir(run.dataFolder, { recursive: true });
    await writeState(run.dataFolder, state);
    (await seenFor(run)).keepFolders(new Set(state.folders));
    console.log(`Started the nightly sweep of ${state.folders.length} album folders`);
  }

  run.sweeping = true;
  let changedFolderCount = 0;
  while (state.next < state.folders.length && run.deadline - Date.now() > FOLDER_BUDGET_MS) {
    const folder = state.folders[state.next];
    const files = await changedFiles(run, await audioFiles(path.join(run.root, folder)));
    // Nothing in the folder changed, so it isn't opened, and its place is saved with the next one.
    if (!files.length) {
      state.next++;
      continue;
    }
    changedFolderCount++;
    const { left, cutShort } = await processFiles(files, run);
    // A folder the run had no time to finish starts over in the next run.
    if (left.length) {
      if (!cutShort.length) break;
      state.cuts = state.cutFolder === folder ? state.cuts + 1 : 1;
      state.cutFolder = folder;
      if (state.cuts < MAX_CUTS) {
        await writeState(run.dataFolder, state);
        break;
      }
      console.log(
        `${folder}: too big to finish in a scheduled run, so the sweep skipped it. Use Fix metadata on it.`,
      );
    }
    state.next++;
    await writeState(run.dataFolder, state);
    await run.seen.saveNowAndThen();
  }
  if (state.next >= state.folders.length && !state.finishedAt) {
    state.finishedAt = Date.now();
    console.log(
      `Finished the nightly sweep of ${state.folders.length} album folders, ${changedFolderCount} of them with new or changed files`,
    );
  }
  await writeState(run.dataFolder, state);
  return state;
}
