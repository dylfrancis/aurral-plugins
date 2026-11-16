// Downloads wait in a queue file until the schedule handles them, because an event gets 10 seconds.
// Events and schedules run in separate processes, so the schedule moves the queue aside to read it.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { sleep } from "./net.js";

const QUEUE = "queue.jsonl";
const CLAIMED = "claimed-";

export async function enqueue(dataFolder, filePath) {
  await fs.mkdir(dataFolder, { recursive: true });
  await fs.appendFile(
    path.join(dataFolder, QUEUE),
    `${JSON.stringify({ path: filePath, at: Date.now() })}\n`,
  );
}

// Also picks up a claim a crashed run left behind, so nothing is lost.
export async function claimQueue(dataFolder) {
  await fs.mkdir(dataFolder, { recursive: true });
  const moved = await fs
    .rename(
      path.join(dataFolder, QUEUE),
      path.join(dataFolder, `${CLAIMED}${Date.now()}-${randomUUID()}.jsonl`),
    )
    .then(
      () => true,
      () => false,
    );
  // Lets an event that opened the old file just before the move finish writing.
  if (moved) await sleep(1_000);

  const files = (await fs.readdir(dataFolder)).filter((name) => name.startsWith(CLAIMED));
  const latest = new Map();
  for (const name of files) {
    const text = await fs.readFile(path.join(dataFolder, name), "utf8").catch(() => "");
    for (const line of text.split("\n")) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof entry?.path !== "string" || !Number.isFinite(entry.at)) continue;
      const seen = latest.get(entry.path);
      if (!seen || seen.at < entry.at) latest.set(entry.path, entry);
    }
  }
  return { files, entries: [...latest.values()] };
}

// Puts back what the run didn't get to, then drops the claim.
export async function releaseQueue(dataFolder, claim, keep) {
  if (keep.length)
    await fs.appendFile(
      path.join(dataFolder, QUEUE),
      keep.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
    );
  for (const name of claim.files) await fs.rm(path.join(dataFolder, name), { force: true });
}
