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
| **Save lyrics files** | Saves synced lyrics from LRCLIB in an `.lrc` file next to each track. Aurral reads it first, and moves and deletes it with the track. |
| **Embed lyrics** | Puts lyrics from LRCLIB inside each file: synced when LRCLIB has them, plain otherwise. Most players that read lyrics tags understand the timestamps. |
| **Add release details** | Adds what MusicBrainz knows about the release, named as MusicBrainz Picard names it: the full release date, original date, label, catalog number, barcode, ISRC, media, release country, type and status, track and disc totals, artist and album artist sort names, the compilation flag, and the release track ID. Needs the release ID Aurral writes. |
| **Clean tags** | Removes encoder notes, web links, junk comments, purchase details, private frames, and every picture but the cover, such as disc scans. Removes old ID3v1 and APE tags from MP3s, and ID3 and APE tags from FLAC and Ogg files. Moves MP3 tags to ID3v2.4. |
| **Add ReplayGain** | Measures each track's loudness with ffmpeg and adds track and album gain, for other players: Subsonic apps, another server reading the same folder, or files you copy to a phone. Aurral levels volume on its own and doesn't need it. Opus files get R128 gains. Uses a lot of CPU. |
| **Replace existing values** | Off, the plugin only fills in what a file is missing, and keeps a cover, lyrics, details, or ReplayGain the file already has. On, it replaces them. |

## Use

**New downloads.** When Aurral files a download, the plugin notes it. Every 15 minutes it works on the albums whose downloads have stopped arriving for 5 minutes, so a whole album is there before its album gain is measured. A track whose lookup failed, for example because LRCLIB was down, gets two more tries.

**Your library.** Choose **Fix metadata** in an album's or a track's menu. Only admins see it. It runs in the background, and its message says what changed.

- The plugin only changes files in the Library folder. Read-only folders belong to other apps, like Lidarr, so it skips them, and it skips Aurral's own folders, like flows.
- It writes each file to a copy beside it and moves the copy into place, so a crash never leaves half a file. A file hardlinked from a download client, like a torrent that's still seeding, gets its own copy and the client's file stays as it was.
- Album gain covers every track of the album in the folder. When a track joins the album later, the plugin measures the album again and updates its other tracks.
- It caches what MusicBrainz says about each release for 30 days in its data folder.

## Privacy

The plugin sends the release IDs in your files to MusicBrainz and the Cover Art Archive, and the artist, title, album, and length of your tracks to LRCLIB. ReplayGain runs on your server.

## Development

`index.js` and `lib/` are the plugin. `vendor/taglib.js` is [node-taglib-sharp](https://github.com/benrr101/node-taglib-sharp), bundled because Aurral installs no packages. To update it, change its version in the root `package.json` and run `pnpm install && pnpm build`. See `vendor/NOTICE.md` for its license.

## License

MIT. `vendor/taglib.js` is LGPL-2.1-or-later.
