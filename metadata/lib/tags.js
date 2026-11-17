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
const { MpegAudioFileSettings, SeekOrigin } = taglib;

// The same setting Aurral writes genres with.
Id3v2Settings.useNumericGenres = false;
// taglib gives an MP3 without an ID3v1 tag a new one when it opens it, which every save fills in
// and writes out, so Clean tags would add the tag it removes.
MpegAudioFileSettings.defaultTagTypes = TagTypes.Id3v2;

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

export function openFile(filePath, abstraction) {
  if (isFragmentedMp4(filePath)) throw new UnsupportedFile("that are fragmented MP4 files");
  const style = ReadStyle.Average | ReadStyle.PictureLazy;
  try {
    return abstraction
      ? File.createFromAbstraction(abstraction, undefined, style)
      : File.createFromPath(filePath, undefined, style);
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

// Thrown when a save can't be written into the file as it stands: it changes the file's size, or
// it moves more bytes than any tag holds, as a shrinking tag that pulls the audio forward does.
class NeedsCopy extends Error {}

const PAGE_BYTES = 64 * 1024;
const MAX_OVERLAY_BYTES = 32 * 1024 * 1024;

function readAt(fd, buffer, offset, length, position) {
  let done = 0;
  while (done < length) {
    const count = readSync(fd, buffer, offset + done, length - done, position + done);
    if (!count) break;
    done += count;
  }
  return done;
}

// The file as a save would leave it, kept in memory. taglib reads the file through it and its
// writes stay here, so the plugin learns what a save changes before anything on disk does.
class Overlay {
  constructor(name, fd) {
    this.name = name;
    this.fd = fd;
    this.length = fstatSync(fd).size;
    this.dirtyPages = new Map();
  }

  // Each stream keeps its own position, like the same file opened twice, since taglib reads a
  // lazy picture through a second stream.
  get readStream() {
    return new OverlayStream(this, false);
  }

  get writeStream() {
    return new OverlayStream(this, true);
  }

  closeStream() {}

  read(buffer, offset, length, position) {
    const count = Math.max(0, Math.min(length, this.length - position));
    readAt(this.fd, buffer, offset, count, position);
    const end = position + count;
    for (let index = Math.floor(position / PAGE_BYTES); index * PAGE_BYTES < end; index++) {
      const page = this.dirtyPages.get(index);
      if (!page) continue;
      const pageStart = index * PAGE_BYTES;
      const from = Math.max(position, pageStart);
      const to = Math.min(end, pageStart + PAGE_BYTES);
      buffer.set(page.subarray(from - pageStart, to - pageStart), offset + from - position);
    }
    return count;
  }

  write(buffer, offset, length, position) {
    if (position + length > this.length) throw new NeedsCopy();
    for (let done = 0; done < length; ) {
      const at = position + done;
      const index = Math.floor(at / PAGE_BYTES);
      const within = at - index * PAGE_BYTES;
      const count = Math.min(PAGE_BYTES - within, length - done);
      this.dirtyPage(index).set(buffer.subarray(offset + done, offset + done + count), within);
      done += count;
    }
  }

  dirtyPage(index) {
    let page = this.dirtyPages.get(index);
    if (!page) {
      if ((this.dirtyPages.size + 1) * PAGE_BYTES > MAX_OVERLAY_BYTES) throw new NeedsCopy();
      page = Buffer.alloc(PAGE_BYTES);
      readAt(this.fd, page, 0, PAGE_BYTES, index * PAGE_BYTES);
      this.dirtyPages.set(index, page);
    }
    return page;
  }

  // The bytes the save changed, as runs to write at their positions in the file.
  changedRuns() {
    const original = Buffer.alloc(PAGE_BYTES);
    const runs = [];
    for (const index of [...this.dirtyPages.keys()].sort((a, b) => a - b)) {
      const page = this.dirtyPages.get(index);
      const size = Math.min(PAGE_BYTES, this.length - index * PAGE_BYTES);
      readAt(this.fd, original, 0, size, index * PAGE_BYTES);
      if (page.subarray(0, size).equals(original.subarray(0, size))) continue;
      let first = 0;
      while (page[first] === original[first]) first++;
      let last = size;
      while (page[last - 1] === original[last - 1]) last--;
      runs.push({ position: index * PAGE_BYTES + first, bytes: page.subarray(first, last) });
    }
    return runs;
  }
}

class OverlayStream {
  constructor(overlay, canWrite) {
    this.overlay = overlay;
    this.canWrite = canWrite;
    this.position = 0;
  }

  get length() {
    return this.overlay.length;
  }

  close() {}

  read(buffer, offset, length) {
    const count = this.overlay.read(buffer, offset, length, this.position);
    this.position += count;
    return count;
  }

  write(buffer, offset, length) {
    const bytes = buffer instanceof ByteVector ? buffer.toByteArray() : buffer;
    this.overlay.write(bytes, offset, length, this.position);
    this.position += length;
    return length;
  }

  seek(offset, origin) {
    const base =
      origin === SeekOrigin.Current ? this.position : origin === SeekOrigin.End ? this.length : 0;
    this.position = base + offset;
  }

  setLength(length) {
    if (length !== this.overlay.length) throw new NeedsCopy();
  }
}

// taglib leaves only 1 KB of padding when a FLAC or ID3v2 tag grows. A filler saved with the tags
// and removed in a second save, which fits, leaves its space as padding for later edits.
const PADDING_BYTES = 64 * 1024;
const FILLER = "AURRAL_PADDING";

function addFiller(file) {
  const extension = path.extname(file.name).toLowerCase();
  if (extension === ".flac") {
    file.getTag(TagTypes.Xiph, true).setFieldAsStrings(FILLER, "x".repeat(PADDING_BYTES));
    return true;
  }
  const id3 = extension === ".mp3" && file.getTag(TagTypes.Id3v2, false);
  if (!id3) return false;
  const frame = Id3v2UserTextInformationFrame.fromDescription(FILLER, StringType.Latin1);
  frame.text = ["x".repeat(PADDING_BYTES)];
  id3.addFrame(frame);
  return true;
}

function removeFiller(file) {
  file.getTag(TagTypes.Xiph, false)?.removeField(FILLER);
  const id3 = file.getTag(TagTypes.Id3v2, false);
  for (const frame of id3 ? userTextFrames(id3, FILLER) : []) id3.removeFrame(frame);
}

function saveWith(filePath, edit) {
  const file = openFile(filePath);
  try {
    const result = edit(file);
    file.save();
    return result;
  } finally {
    file.dispose();
  }
}

const CHANGED_WHILE_WRITING =
  "changed while the plugin was writing it, so the plugin left it alone";
const changedSince = (before, now) => now.mtimeMs !== before.mtimeMs || now.size !== before.size;

// Writes the changed bytes into the file. Returns false when the plugin may replace the file but
// not write to it, as with a file another user owns in a folder the plugin can write to.
async function writeInPlace(filePath, runs, before) {
  let handle;
  try {
    handle = await fs.open(filePath, "r+");
  } catch (error) {
    if (error.code === "EACCES" || error.code === "EPERM") return false;
    throw error;
  }
  try {
    if (changedSince(before, await handle.stat())) throw new Error(CHANGED_WHILE_WRITING);
    for (const { position, bytes } of runs) await handle.write(bytes, 0, bytes.length, position);
    return true;
  } finally {
    await handle.close();
  }
}

// Edits a copy beside the file and moves it into place, so a crash never leaves half a file and
// another link to the file keeps the file as it was. A FLAC or MP3 whose size changes gets padding.
async function writeCopy(filePath, edit, before, resized) {
  const extension = path.extname(filePath);
  const working = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath, extension)}.${randomUUID()}.tagging${extension}`,
  );
  await fs.copyFile(filePath, working, fs.constants.COPYFILE_FICLONE);
  try {
    let padded = false;
    const changes = saveWith(working, (file) => {
      const changes = edit(file);
      padded = resized && addFiller(file);
      return changes;
    });
    if (padded) saveWith(working, removeFiller);
    if (changedSince(before, await fs.stat(filePath))) throw new Error(CHANGED_WHILE_WRITING);
    await fs.rename(working, filePath);
    return changes;
  } catch (error) {
    await fs.rm(working, { force: true }).catch(() => {});
    throw error;
  }
}

// Runs edit on the file and returns its changes, or none when saving leaves the same bytes. A dry
// run writes nothing. Tags that fit are written in place, and the rest get a copy.
export async function rewrite(filePath, edit, { dryRun = false } = {}) {
  const before = await fs.stat(filePath);
  const fd = openSync(filePath, "r");
  let changes;
  let runs = null;
  try {
    const overlay = new Overlay(filePath, fd);
    const file = openFile(filePath, overlay);
    try {
      changes = edit(file);
      if (changes.length && !dryRun) {
        try {
          file.save();
          runs = overlay.changedRuns();
        } catch (error) {
          if (!(error instanceof NeedsCopy)) throw error;
        }
      }
    } finally {
      file.dispose();
    }
  } finally {
    closeSync(fd);
  }
  if (!changes.length || dryRun) return changes;
  // A change the tag can't hold, like a frame its version lacks, saves the same bytes. Leaving
  // the file alone keeps it from being rewritten on every run.
  if (runs?.length === 0) return [];
  if (runs && before.nlink === 1 && (await writeInPlace(filePath, runs, before))) return changes;
  return writeCopy(filePath, edit, before, !runs);
}
