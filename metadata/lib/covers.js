import fs from "node:fs/promises";
import path from "node:path";
import { isMbid } from "./musicbrainz.js";
import { request } from "./net.js";
import { MAX_PICTURE_BYTES } from "./tags.js";

// The names Aurral reads an album folder's cover from, best first. WebP is
// left out because few players read an embedded WebP cover.
const NAMES = ["cover", "folder", "front", "album"];
const EXTENSIONS = new Set([".jpg", ".jpeg", ".png"]);

function imageType(data) {
  if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff)
    return "image/jpeg";
  if (data.length > 8 && data.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")))
    return "image/png";
  return null;
}

const usable = (data) => {
  const mimeType = data && data.length <= MAX_PICTURE_BYTES ? imageType(data) : null;
  return mimeType ? { data, mimeType } : null;
};

// The album folder's cover image, whether Aurral, Lidarr or the download put it there. Aurral and
// Navidrome both show it ahead of the art inside the files.
export async function folderCover(folder) {
  const names = await fs.readdir(folder).catch(() => []);
  const ranked = names
    .map((name) => ({
      name,
      rank: NAMES.indexOf(path.basename(name, path.extname(name)).toLowerCase()),
    }))
    .filter(({ name, rank }) => rank >= 0 && EXTENSIONS.has(path.extname(name).toLowerCase()))
    .sort((left, right) => left.rank - right.rank);
  for (const { name } of ranked) {
    const cover = usable(await fs.readFile(path.join(folder, name)).catch(() => null));
    if (cover) return cover;
  }
  return null;
}

async function coverArtArchive(kind, mbid, deadline) {
  if (!isMbid(mbid)) return null;
  const response = await request(
    `https://coverartarchive.org/${kind}/${mbid.toLowerCase()}/front-1200`,
    { deadline, service: "the Cover Art Archive", accept: "image/*" },
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`The Cover Art Archive answered ${response.status}`);
  return usable(Buffer.from(await response.arrayBuffer()));
}

// How many ranked releases to try before falling back to the file's own release.
const MAX_EDITIONS = 5;

// The front cover of the first ranked release that has one, else of the file's own release, else
// of its release group.
export async function archiveCover(info, deadline, editions = []) {
  const tried = editions.slice(0, MAX_EDITIONS);
  for (const id of tried) {
    const cover = await coverArtArchive("release", id, deadline);
    if (cover) return cover;
  }
  const own = tried.includes(String(info.releaseMbid).toLowerCase())
    ? null
    : await coverArtArchive("release", info.releaseMbid, deadline);
  return own ?? (await coverArtArchive("release-group", info.releaseGroupMbid, deadline));
}
