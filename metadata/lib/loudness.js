import { spawn } from "node:child_process";
import { checkTime, OutOfTime } from "./net.js";

// ReplayGain 2.0 plays every track at -18 LUFS. Opus R128 gains are relative
// to -23 LUFS and stored as Q7.8 integers.
const REFERENCE_LUFS = -18;
const R128_LUFS = -23;
const SILENT_LUFS = -70;
const MEASURE_LIMIT_MS = 5 * 60_000;

const FRAME = /\bt:\s*([\d.]+)\s.*?\bM:\s*(-?[\d.]+|-inf)/;
const INTEGRATED = /^\s*I:\s*(-?[\d.]+|-inf)\s*LUFS/;
const PEAK = /^\s*Peak:\s*(-?[\d.]+|-inf)\s*dBFS/;

const number = (text) => (text === "-inf" ? Number.NEGATIVE_INFINITY : Number(text));

export function ffmpegVersion() {
  return new Promise((resolve) => {
    const child = spawn("ffmpeg", ["-hide_banner", "-version"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) =>
      resolve(code === 0 ? (/ffmpeg version (\S+)/.exec(output)?.[1] ?? "unknown") : null),
    );
  });
}

// Measures a file's integrated loudness and sample peak with ffmpeg's ebur128
// filter, and keeps the loudness of every 400 ms block so an album's loudness
// can be measured across its tracks.
export function measure(filePath, deadline) {
  checkTime(deadline, 15_000);
  return new Promise((resolve, reject) => {
    const child = spawn(
      "ffmpeg",
      [
        "-nostdin",
        "-nostats",
        "-hide_banner",
        "-i",
        filePath,
        "-map",
        "0:a:0",
        "-af",
        "ebur128=peak=sample:framelog=info",
        "-f",
        "null",
        "-",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    const blocks = [];
    let summary = false;
    let integrated = null;
    let peakDb = null;
    let pending = "";
    let timedOut = false;
    const read = (line) => {
      if (line.includes("Summary:")) summary = true;
      if (!summary) {
        const frame = FRAME.exec(line);
        // ffmpeg logs a block every 100 ms; the first full 400 ms block ends at 0.4 s.
        if (frame && Number(frame[1]) >= 0.399) blocks.push(number(frame[2]));
        return;
      }
      const loudness = INTEGRATED.exec(line);
      if (loudness) integrated = number(loudness[1]);
      const peak = PEAK.exec(line);
      if (peak) peakDb = number(peak[1]);
    };
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      const lines = (pending + chunk).split(/\r?\n/);
      pending = lines.pop();
      lines.forEach(read);
    });
    const timer = setTimeout(
      () => {
        timedOut = true;
        child.kill("SIGKILL");
      },
      Math.max(1_000, Math.min(MEASURE_LIMIT_MS, deadline - Date.now() - 5_000)),
    );
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(
        error.code === "ENOENT"
          ? new Error("ReplayGain needs ffmpeg, and the plugin can't find it")
          : error,
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      read(pending);
      if (timedOut) {
        reject(
          Date.now() >= deadline - 10_000 ? new OutOfTime() : new Error("ffmpeg took too long"),
        );
        return;
      }
      if (code !== 0 || integrated === null || peakDb === null) {
        reject(new Error("ffmpeg couldn't measure it"));
        return;
      }
      resolve({
        integrated,
        peak: peakDb === Number.NEGATIVE_INFINITY ? 0 : 10 ** (peakDb / 20),
        blocks,
      });
    });
  });
}

// The integrated loudness of several tracks played back to back, gated as
// ITU-R BS.1770 gates one track: blocks under -70 LUFS are dropped, then
// blocks more than 10 LU under the loudness of the rest.
export function combinedLoudness(blockLists) {
  const blocks = blockLists.flat().filter((value) => value > SILENT_LUFS);
  if (!blocks.length) return null;
  const loudness = (values) =>
    10 * Math.log10(values.reduce((sum, value) => sum + 10 ** (value / 10), 0) / values.length);
  const ungated = loudness(blocks);
  return loudness(blocks.filter((value) => value > ungated - 10));
}

const r128 = (lufs) => Math.max(-32768, Math.min(32767, Math.round((R128_LUFS - lufs) * 256)));

export function gainFor(lufs, peak) {
  if (lufs === null || !(lufs > SILENT_LUFS)) return null;
  const gain = REFERENCE_LUFS - lufs;
  return {
    gain: Math.round(gain * 100) / 100,
    peak: Math.round(peak * 1e6) / 1e6,
    r128: r128(lufs),
  };
}
