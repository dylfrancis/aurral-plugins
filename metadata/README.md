# Metadata

An [Aurral](https://github.com/lklynet/aurral) plugin that finishes the tags on your music. It embeds the cover, saves lyrics, adds release details from MusicBrainz, cleans out junk tags, and adds ReplayGain.

Aurral already tags every download with its title, artists, album, album artist, year, track and disc numbers, genres, and MusicBrainz IDs, and puts a `cover.jpg` in the album folder. The plugin adds what Aurral leaves out, and never changes the tags Aurral writes.

## Install

Needs an Aurral with plugins, currently nightly.

1. In **Settings > Plugins**, select **use the official plugins** under **Install from a link**, and choose **Metadata**.
2. Open **Metadata** and turn on what you want it to do. Everything starts off.
3. Select **Test**, then turn the plugin on.

## Settings

| Setting | What it does |
| --- | --- |
| **Embed covers** | Puts the album cover inside each file. It uses the cover in the album folder, which is the one Aurral shows, including one you chose in Aurral. Without one, it uses the release's front cover on the Cover Art Archive, then the release group's. |
| **Prefer digital covers** | When the plugin takes a cover from the Cover Art Archive, it ranks the album's releases first, since a CD release's front cover is often a photo of the case: official digital releases before CDs, plain releases before variants with alternate artwork, then worldwide, US, UK and Europe. It tries the first five, then the file's own release. A cover in the album folder still comes first, and a cover a file already has stays unless **Replace existing values** is on. |
| **Save lyrics files** | Saves synced lyrics from LRCLIB in an `.lrc` file next to each track. Aurral reads it first, and moves and deletes it with the track. |
| **Embed lyrics** | Puts lyrics from LRCLIB inside each file: synced when LRCLIB has them, plain otherwise. Most players that read lyrics tags understand the timestamps. |
| **Add release details** | Adds what MusicBrainz knows about the release, named as MusicBrainz Picard names it: the full release date, original date, label, catalog number, barcode, ISRC, media, release country, type and status, track and disc totals, artist and album artist sort names, the compilation flag, and the release track ID. Needs the release ID Aurral writes. |
| **Clean tags** | Removes encoder notes, web links, junk comments, purchase details, private frames, and every picture but the cover, such as disc scans. Removes old ID3v1 and APE tags from MP3s, and ID3 and APE tags from FLAC and Ogg files. Moves MP3 tags to ID3v2.4. In FLAC and Ogg files, it also removes the `TRACK`, `DISC`, `TOTALTRACKS`, `TOTALDISCS` and `ALBUM ARTIST` fields another tagger left, such as Tidal's, when they disagree with the real ones, because players like Navidrome read them first. |
| **Add ReplayGain** | Measures each track's loudness with ffmpeg and adds track and album gain, for other players: Subsonic apps, another server reading the same folder, or files you copy to a phone. Aurral levels volume on its own and doesn't need it. Opus files get R128 gains. Uses a lot of CPU. |
| **Replace existing values** | Off, the plugin only fills in what a file is missing, and keeps a cover, lyrics, details, or ReplayGain the file already has. On, it replaces them. |
| **Sweep the library every night** | Goes through the Library once a night and does what's turned on, like a cron job, for files that are new or changed since the plugin last handled them. See [Nightly sweep](#nightly-sweep). |
| **Hour to start the sweep** | 0 to 23, in the server's time zone, which is UTC unless the container sets `TZ`. Empty starts at 3. |
| **Dry run** | Logs what the plugin would change, under `plugin:metadata` in Aurral's log, without changing any file. Downloads it handles in a dry run leave the queue, so turn on the sweep to pick them up later. |

## Use

**New downloads.** When Aurral files a download, the plugin notes it. Every 15 minutes it works on the albums whose downloads have stopped arriving for 5 minutes, so a whole album is there before its album gain is measured. A track whose lookup failed, for example because LRCLIB was down, gets two more tries.

**Your library.** Choose **Fix metadata** in an album's or a track's menu. Only admins see it. It runs in the background, and its message says what changed.

- The plugin only changes files in the Library folder. Read-only folders belong to other apps, like Lidarr, so it skips them, and it skips Aurral's own folders, like flows.
- When the new tags fit in the space the old ones took, as they usually do in FLAC and MP3 files, it writes only the bytes that changed. A crash in the middle can leave the tags half written, but never the audio.
- When the tags don't fit, it writes the file to a copy beside it and moves the copy into place, so a crash never leaves half a file. The copy gets 64 KB of spare tag space in FLAC and MP3 files, so the next edits fit.
- A file hardlinked from a download client, like a torrent that's still seeding, always gets its own copy, and the client's file stays as it was.
- Album gain covers every track of the album in the folder. When a track joins the album later, the plugin measures the album again and updates its other tracks.
- It caches what MusicBrainz says about each release for 30 days in its data folder.
- Each album folder it changes gets a line in Aurral's log under `plugin:metadata`.

**Nightly sweep.** With the sweep on, the 15-minute run starts a pass over every album folder in the Library once a day at the hour you set, after any new downloads. It saves its place in its data folder, so a big library carries on over as many runs as it needs.

- The plugin records each file's size and modified time after it handles the file, from the sweep, a download, or **Fix metadata**. A sweep only opens files that are new or changed since then, such as an album another app imported or retagged, so a night with nothing new takes about a second.
- Changing a setting that affects files, or updating the plugin, has the next sweep look at every file again.
- A file that hasn't changed isn't looked up again, so lyrics or a cover that LRCLIB or the Cover Art Archive adds later reach it only when it changes, after a setting change, or with **Fix metadata**.
- A track whose lookup failed, for example because LRCLIB was down, isn't recorded, so the next sweep tries it again.
- For files that did change, a sweep skips an album the Cover Art Archive had no cover for, or a track LRCLIB had no lyrics for, in the last two weeks. **Fix metadata** always asks again.
- With ReplayGain on, the first sweep measures every track in the library, which takes a lot of CPU for a while. Later sweeps only measure new tracks.
- An album folder too big to finish in one 10-minute run is skipped after three tries, with a line in the log. Run **Fix metadata** on it instead, which gets 30 minutes. The same goes for a download.
- Turning **Dry run** on or off starts a new sweep.

## Privacy

The plugin sends the release IDs in your files to MusicBrainz and the Cover Art Archive, and the artist, title, album, and length of your tracks to LRCLIB. ReplayGain runs on your server.

## Development

`index.js` and `lib/` are the plugin. `vendor/taglib.js` is [node-taglib-sharp](https://github.com/benrr101/node-taglib-sharp), bundled because Aurral installs no packages. To update it, change its version in the root `package.json` and run `pnpm install && pnpm build`. See `vendor/NOTICE.md` for its license.

## License

MIT. `vendor/taglib.js` is LGPL-2.1-or-later.
