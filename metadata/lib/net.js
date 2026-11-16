import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
export const PLUGIN_VERSION = version;

export const USER_AGENT = `AurralMetadata/${version} ( https://github.com/lklynet/aurral-plugins )`;

// Thrown near a run's time limit, so the caller keeps the rest for later instead of letting Aurral
// time the call out, which counts against the plugin.
export class OutOfTime extends Error {
  constructor() {
    super("Ran out of time");
  }
}

export function checkTime(deadline, needMs = 5_000) {
  if (deadline - Date.now() < needMs) throw new OutOfTime();
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A connection that fails, as one can right after ffmpeg kept the CPU busy, is
// tried twice more. An answer the service gives, even an error, is returned.
export async function request(url, { deadline, service, accept = "application/json" }) {
  for (let attempt = 1; ; attempt++) {
    checkTime(deadline);
    try {
      return await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: accept },
        signal: AbortSignal.timeout(Math.min(30_000, deadline - Date.now())),
      });
    } catch (error) {
      const cause = error.cause?.code || error.cause?.message || error.name;
      console.warn(`${service}: ${error.message} (${cause}), attempt ${attempt} of 3`);
      if (attempt === 3) {
        checkTime(deadline);
        throw new Error(`Couldn't reach ${service}`);
      }
      await sleep(1_000 * attempt);
    }
  }
}
