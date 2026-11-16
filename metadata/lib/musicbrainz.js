import fs from "node:fs/promises";
import path from "node:path";
import { request, sleep } from "./net.js";

const API = "https://musicbrainz.org/ws/2";
const INCLUDES = "artist-credits+labels+recordings+release-groups+media+isrcs";
const CACHE_MS = 30 * 24 * 3600 * 1000;
const VARIOUS_ARTISTS = "89ad4ac3-39f7-470e-963a-56509c546377";

// Tags come from files other people made, so an ID is checked before it goes
// into a URL or a file name.
export const isMbid = (value) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value ?? ""));

// MusicBrainz allows one request a second from each client.
let lastCall = 0;
async function politely() {
  const wait = lastCall + 1_100 - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
}

const credit = (credits) =>
  (credits ?? []).map((entry) => ({
    name: entry.name,
    joinphrase: entry.joinphrase,
    id: entry.artist?.id,
    sortName: entry.artist?.["sort-name"],
  }));

// Keeps the fields the plugin writes, so the cache stays small.
function compact(release) {
  const group = release["release-group"] ?? {};
  return {
    date: release.date,
    country: release.country,
    status: release.status,
    barcode: release.barcode,
    artistCredit: credit(release["artist-credit"]),
    labels: (release["label-info"] ?? []).map((info) => ({
      name: info.label?.name,
      catalogNumber: info["catalog-number"],
    })),
    group: {
      firstReleaseDate: group["first-release-date"],
      primaryType: group["primary-type"],
      secondaryTypes: group["secondary-types"] ?? [],
    },
    media: (release.media ?? []).map((medium) => ({
      position: medium.position,
      format: medium.format,
      trackCount: medium["track-count"],
      tracks: (medium.tracks ?? []).map((track) => ({
        id: track.id,
        position: track.position,
        artistCredit: credit(track["artist-credit"]),
        recording: {
          id: track.recording?.id,
          isrcs: track.recording?.isrcs ?? [],
          artistCredit: credit(track.recording?.["artist-credit"]),
        },
      })),
    })),
  };
}

// The JSON MusicBrainz answers with, or null when it has no such entity.
async function lookup(pathAndQuery, deadline) {
  for (let attempt = 1; ; attempt++) {
    await politely();
    const response = await request(`${API}${pathAndQuery}`, { deadline, service: "MusicBrainz" });
    // MusicBrainz answers 503 when it's busy or the client asks too often.
    if (response.status === 503 && attempt < 4) {
      await sleep(2_000 * attempt);
      continue;
    }
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`MusicBrainz answered ${response.status}`);
    return response.json();
  }
}

// Answers from the data folder while under 30 days old, else from load, and saves what it returns.
async function cached(dataFolder, name, load) {
  const file = path.join(dataFolder, "musicbrainz", `${name}.json`);
  const saved = await fs
    .readFile(file, "utf8")
    .then(JSON.parse)
    .catch(() => null);
  if (saved && Date.now() - saved.fetchedAt < CACHE_MS) return saved.value ?? saved.release;
  const value = await load();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ fetchedAt: Date.now(), value }));
  return value;
}

export async function getRelease(mbid, { dataFolder, deadline }) {
  if (!isMbid(mbid)) return null;
  const id = mbid.toLowerCase();
  return cached(dataFolder, id, async () => {
    const release = await lookup(`/release/${id}?inc=${INCLUDES}&fmt=json`, deadline);
    return release && compact(release);
  });
}

const GROUP_PAGE_SIZE = 100;
const MAX_GROUP_PAGES = 3;

// The releases of a release group, with what ranking their covers needs.
export async function getGroupReleases(mbid, { dataFolder, deadline }) {
  if (!isMbid(mbid)) return [];
  const id = mbid.toLowerCase();
  return cached(dataFolder, `group-${id}`, async () => {
    const releases = [];
    for (let page = 0; page < MAX_GROUP_PAGES; page++) {
      const query = `release-group=${id}&inc=media&fmt=json&limit=${GROUP_PAGE_SIZE}&offset=${page * GROUP_PAGE_SIZE}`;
      const answer = await lookup(`/release?${query}`, deadline);
      const batch = answer?.releases ?? [];
      releases.push(
        ...batch.map((release) => ({
          id: release.id,
          status: release.status,
          country: release.country,
          disambiguation: release.disambiguation,
          formats: (release.media ?? []).map((medium) => medium.format ?? ""),
          front: release["cover-art-archive"]?.front === true,
        })),
      );
      if (batch.length < GROUP_PAGE_SIZE || releases.length >= (answer["release-count"] ?? 0))
        break;
    }
    return releases;
  });
}

// Countries whose release counts as a normal edition, best first.
const GOOD_COUNTRIES = ["XW", "US", "GB", "XE"];
const isDigital = ({ formats }) =>
  formats.length > 0 && formats.every((format) => format === "Digital Media");
const isCdOrDigital = ({ formats }) =>
  formats.length > 0 &&
  formats.every(
    (format) => format === "Digital Media" || (format.includes("CD") && format !== "CD-R"),
  );

// The releases to take a front cover from, best first: digital before CD, since a CD release's
// cover is often a photo of the case; plain before variants with other artwork; then by country.
export function coverEditions(releases) {
  const countryRank = ({ country }) =>
    country ? GOOD_COUNTRIES.indexOf(country) : GOOD_COUNTRIES.length;
  return releases
    .filter(
      (release) =>
        release.front &&
        release.status?.toLowerCase() === "official" &&
        isCdOrDigital(release) &&
        countryRank(release) >= 0,
    )
    .sort(
      (left, right) =>
        Number(!isDigital(left)) - Number(!isDigital(right)) ||
        Number(Boolean(left.disambiguation)) - Number(Boolean(right.disambiguation)) ||
        countryRank(left) - countryRank(right),
    )
    .map((release) => release.id);
}

const sortName = (credits) =>
  credits?.length
    ? credits
        .map((entry) => `${entry.sortName || entry.name || ""}${entry.joinphrase || ""}`)
        .join("")
        .trim() || null
    : null;

// MusicBrainz names a missing label "[no label]" and a missing number "[none]".
const known = (value) => {
  const text = String(value ?? "").trim();
  return text && !/^\[.*\]$/.test(text) ? text : null;
};
const uniqueKnown = (values) => [...new Set(values.map(known).filter(Boolean))];

// The release details for one file, named as Picard writes them. Its track is found by its
// recording ID, or by disc and track number when it has none.
export function trackDetails(release, file) {
  const entries = release.media.flatMap((medium) =>
    medium.tracks.map((track) => ({ medium, track })),
  );
  const atPosition = ({ medium, track }) =>
    medium.position === (file.disc || 1) && track.position === file.track;
  const recording = isMbid(file.recordingMbid) ? file.recordingMbid.toLowerCase() : null;
  const byRecording = recording
    ? entries.filter(({ track }) => track.recording.id === recording)
    : [];
  const match =
    byRecording.find(atPosition) ??
    byRecording[0] ??
    (!recording && file.track ? entries.find(atPosition) : undefined);

  const types = [release.group.primaryType, ...release.group.secondaryTypes]
    .filter(Boolean)
    .map((type) => type.toLowerCase());
  return {
    date: known(release.date),
    originalDate: known(release.group.firstReleaseDate),
    label: uniqueKnown(release.labels.map((label) => label.name)),
    catalogNumber: uniqueKnown(release.labels.map((label) => label.catalogNumber)),
    barcode: known(release.barcode),
    releaseCountry: known(release.country),
    releaseStatus: known(release.status)?.toLowerCase() ?? null,
    releaseType: types,
    albumArtistSort: sortName(release.artistCredit),
    compilation: release.artistCredit.some((entry) => entry.id === VARIOUS_ARTISTS),
    discCount: release.media.length || null,
    trackCount: match?.medium.trackCount ?? null,
    media: known(match?.medium.format),
    isrc: uniqueKnown(match?.track.recording.isrcs ?? []),
    artistSort: match
      ? sortName(
          match.track.artistCredit.length
            ? match.track.artistCredit
            : match.track.recording.artistCredit,
        )
      : null,
    releaseTrackMbid: match?.track.id ?? null,
  };
}
