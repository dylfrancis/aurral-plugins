import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import taglib from "../vendor/taglib.js";

export const {
  ByteVector,
  File,
  Id3v2FrameClassType,
  Id3v2FrameIdentifiers,
  Id3v2Settings,
  Id3v2UserTextInformationFrame,
  Mpeg4BoxType,
  Picture,
  PictureType,
  ReadStyle,
  StringType,
  TagTypes,
} = taglib;

// The same setting Aurral writes genres with.
Id3v2Settings.useNumericGenres = false;

const ITUNES = "com.apple.iTunes";
export const MAX_PICTURE_BYTES = 4 * 1024 * 1024;
const XIPH_EXTENSIONS = new Set([".flac", ".ogg", ".oga", ".opus"]);
const ID3_EXTENSIONS = new Set([".mp3", ".aiff", ".wav"]);

// The tag family a file uses. MP3s get their own kind since they collect stray ID3v1 and APE tags.
export function kindOf(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".mp3") return "mp3";
  if (XIPH_EXTENSIONS.has(extension)) return "xiph";
  if (ID3_EXTENSIONS.has(extension)) return "id3";
  if (extension === ".m4a") return "mp4";
  return "other";
}

export class UnsupportedFile extends Error {}

// taglib grows the header of a fragmented MP4 without moving the data offsets
// its fragments point at, which breaks the audio. Aurral skips them too.
function isFragmentedMp4(filePath) {
  const fd = openSync(filePath, "r");
  try {
    const size = fstatSync(fd).size;
    const header = Buffer.alloc(16);
    for (let offset = 0; offset + 8 <= size; ) {
      readSync(fd, header, 0, 16, offset);
      const type = header.toString("latin1", 4, 8);
      if (offset === 0 && type !== "ftyp") return false;
      if (type === "moof") return true;
      const boxSize = header.readUInt32BE(0);
      const length =
        boxSize === 1 ? Number(header.readBigUInt64BE(8)) : boxSize === 0 ? size - offset : boxSize;
      if (length < 8) return false;
      offset += length;
    }
    return false;
  } finally {
    closeSync(fd);
  }
}

export function openFile(filePath) {
  if (isFragmentedMp4(filePath)) throw new UnsupportedFile("that are fragmented MP4 files");
  try {
    return File.createFromPath(filePath, undefined, ReadStyle.Average | ReadStyle.PictureLazy);
  } catch (error) {
    if (/unsupported format/i.test(String(error?.message)))
      throw new UnsupportedFile("in a format the plugin can't tag");
    throw error;
  }
}

export function tagsOf(file, kind, create = false) {
  return {
    xiph: file.getTag(TagTypes.Xiph, create && kind === "xiph"),
    id3: file.getTag(TagTypes.Id3v2, create && (kind === "mp3" || kind === "id3")),
    apple: file.getTag(TagTypes.Apple, create && kind === "mp4"),
  };
}

const texts = (values) =>
  (Array.isArray(values) ? values : [values])
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);

function id3Frames(id3, ident) {
  return id3.getFramesByIdentifier(Id3v2FrameClassType.TextInformationFrame, ident);
}

export function userTextFrames(id3, description) {
  const wanted = description.toLowerCase();
  return id3
    .getFramesByClassType(Id3v2FrameClassType.UserTextInformationFrame)
    .filter((frame) => frame.description.toLowerCase() === wanted);
}

// Text tags named as MusicBrainz Picard writes them: a Vorbis comment, an ID3
// frame or TXXX frame, and an iTunes freeform atom.
export const TEXT_FIELDS = {
  originalDate: { xiph: "ORIGINALDATE", id3: "TDOR", apple: "ORIGINALDATE" },
  label: { xiph: "LABEL", id3: "TPUB", apple: "LABEL" },
  catalogNumber: { xiph: "CATALOGNUMBER", txxx: "CATALOGNUMBER", apple: "CATALOGNUMBER" },
  barcode: { xiph: "BARCODE", txxx: "BARCODE", apple: "BARCODE" },
  isrc: { xiph: "ISRC", id3: "TSRC", apple: "ISRC" },
  media: { xiph: "MEDIA", id3: "TMED", apple: "MEDIA" },
  releaseCountry: {
    xiph: "RELEASECOUNTRY",
    txxx: "MusicBrainz Album Release Country",
    apple: "MusicBrainz Album Release Country",
  },
  releaseType: {
    xiph: "RELEASETYPE",
    txxx: "MusicBrainz Album Type",
    apple: "MusicBrainz Album Type",
  },
  releaseStatus: {
    xiph: "RELEASESTATUS",
    txxx: "MusicBrainz Album Status",
    apple: "MusicBrainz Album Status",
  },
  releaseTrackMbid: {
    xiph: "MUSICBRAINZ_RELEASETRACKID",
    txxx: "MusicBrainz Release Track Id",
    apple: "MusicBrainz Release Track Id",
  },
};

export function readText(tags, spec) {
  const found = [
    tags.xiph && texts(tags.xiph.getField(spec.xiph)),
    tags.id3 && spec.id3 && texts(id3Frames(tags.id3, Id3v2FrameIdentifiers[spec.id3])[0]?.text),
    tags.id3 && spec.txxx && texts(userTextFrames(tags.id3, spec.txxx)[0]?.text),
    tags.apple && texts(tags.apple.getItunesStrings(ITUNES, spec.apple)),
  ];
  return found.find((values) => values?.length) ?? [];
}

// ID3v2.3 has no list values, so Picard joins them with "/", and its original
// date frame, TORY, holds only the year.
function id3Values(id3, spec, values) {
  if (id3.version >= 4) return values;
  return spec.id3 === "TDOR" ? [values[0].slice(0, 4)] : [values.join("/")];
}

// The values as the file's tag will hold them, to compare with what it has.
export function asStored(tags, spec, values) {
  return !tags.xiph && !tags.apple && tags.id3 ? id3Values(tags.id3, spec, values) : values;
}

export function writeText(tags, spec, values) {
  if (tags.xiph) tags.xiph.setFieldAsStrings(spec.xiph, ...values);
  if (tags.apple) tags.apple.setItunesStrings(ITUNES, spec.apple, ...values);
  if (tags.id3 && spec.id3)
    tags.id3.setTextFrame(Id3v2FrameIdentifiers[spec.id3], ...id3Values(tags.id3, spec, values));
  if (tags.id3 && spec.txxx) {
    for (const frame of userTextFrames(tags.id3, spec.txxx)) tags.id3.removeFrame(frame);
    const frame = Id3v2UserTextInformationFrame.fromDescription(spec.txxx);
    frame.text = id3Values(tags.id3, spec, values);
    tags.id3.addFrame(frame);
  }
}

// The full release date sits where the year does: DATE, TDRC, or ©day.
// ID3v2.3 has no frame for a full date, so it keeps the year alone.
export function readDate(tags) {
  return (
    texts(tags.xiph?.getField("DATE"))[0] ||
    texts(tags.id3 && id3Frames(tags.id3, Id3v2FrameIdentifiers.TDRC)[0]?.text)[0] ||
    texts(tags.apple?.getFirstQuickTimeString(Mpeg4BoxType.DAY))[0] ||
    ""
  );
}

export function writeDate(tags, date) {
  if (tags.xiph) tags.xiph.setFieldAsStrings("DATE", date);
  if (tags.id3 && tags.id3.version >= 4) tags.id3.setTextFrame(Id3v2FrameIdentifiers.TDRC, date);
  if (tags.apple) tags.apple.setQuickTimeString(Mpeg4BoxType.DAY, date);
}

// What the plugin needs to know about a file before it looks anything up.
export function inspect(filePath) {
  const file = openFile(filePath);
  try {
    const { tag } = file;
    const pictures = tag.pictures ?? [];
    const cover =
      pictures.find((picture) => picture.type === PictureType.FrontCover) ?? pictures.find(isCover);
    const kind = kindOf(filePath);
    const xiph = file.getTag(TagTypes.Xiph, false);
    return {
      kind,
      opus: kind === "xiph" && /opus/i.test(file.properties?.description ?? ""),
      title: tag.title?.trim() || "",
      artist: tag.performers?.[0]?.trim() || "",
      album: tag.album?.trim() || "",
      albumArtist: tag.albumArtists?.[0]?.trim() || "",
      track: tag.track || 0,
      disc: tag.disc || 0,
      releaseMbid: tag.musicBrainzReleaseId || "",
      releaseGroupMbid: tag.musicBrainzReleaseGroupId || "",
      recordingMbid: tag.musicBrainzTrackId || "",
      durationMs: file.properties?.durationMilliseconds || 0,
      hasCover: Boolean(cover),
      coverTooBig: Boolean(cover) && cover.data.length > MAX_PICTURE_BYTES,
      hasLyrics: Boolean(tag.lyrics?.trim()),
      trackGain: readGain(file, xiph, "track"),
      albumGain: readGain(file, xiph, "album"),
    };
  } finally {
    file.dispose();
  }
}

export const isCover = (picture) =>
  picture.type === PictureType.FrontCover || picture.type === PictureType.Other;

// Opus files carry R128 gains as Q7.8 integers instead of ReplayGain tags.
export function readGain(file, xiph, scope) {
  if (xiph && /opus/i.test(file.properties?.description ?? "")) {
    const value = Number.parseInt(xiph.getFieldFirstValue(`R128_${scope.toUpperCase()}_GAIN`), 10);
    return Number.isFinite(value) ? value : Number.NaN;
  }
  return scope === "track" ? file.tag.replayGainTrackGain : file.tag.replayGainAlbumGain;
}

async function sameBytes(left, right) {
  const [a, b] = await Promise.all([fs.open(left), fs.open(right)]);
  try {
    const [sizeA, sizeB] = await Promise.all([a.stat(), b.stat()]).then((stats) =>
      stats.map((stat) => stat.size),
    );
    if (sizeA !== sizeB) return false;
    const chunkA = Buffer.alloc(1 << 20);
    const chunkB = Buffer.alloc(1 << 20);
    for (let position = 0; position < sizeA; position += chunkA.length) {
      const [readA, readB] = await Promise.all([
        a.read(chunkA, 0, chunkA.length, position),
        b.read(chunkB, 0, chunkB.length, position),
      ]);
      if (!chunkA.subarray(0, readA.bytesRead).equals(chunkB.subarray(0, readB.bytesRead)))
        return false;
    }
    return true;
  } finally {
    await Promise.all([a.close(), b.close()]);
  }
}

// Runs edit on the file to see what would change, which is all a dry run does. Otherwise it edits a
// copy and moves it into place, so a crash never leaves half a file and a hardlink keeps its copy.
export async function rewrite(filePath, edit, { dryRun = false } = {}) {
  const before = await fs.stat(filePath);
  const preview = openFile(filePath);
  let planned;
  try {
    planned = edit(preview);
  } finally {
    preview.dispose();
  }
  if (!planned.length || dryRun) return planned;

  const extension = path.extname(filePath);
  const working = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath, extension)}.${randomUUID()}.tagging${extension}`,
  );
  await fs.copyFile(filePath, working, fs.constants.COPYFILE_FICLONE);
  try {
    const file = openFile(working);
    let changes;
    try {
      changes = edit(file);
      file.save();
    } finally {
      file.dispose();
    }
    // A change the tag can't hold, like a frame its version lacks, saves the same bytes. Leaving
    // the file alone keeps it from being rewritten on every run.
    if (await sameBytes(working, filePath)) {
      await fs.rm(working, { force: true });
      return [];
    }
    const now = await fs.stat(filePath);
    if (now.mtimeMs !== before.mtimeMs || now.size !== before.size)
      throw new Error("changed while the plugin was writing it, so the plugin left it alone");
    await fs.rename(working, filePath);
    return changes;
  } catch (error) {
    await fs.rm(working, { force: true }).catch(() => {});
    throw error;
  }
}
