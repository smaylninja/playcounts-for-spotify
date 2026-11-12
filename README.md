<p align="center"> 
   <img src="icons/spotify-play-counts.svg" width="520" height="128" align="middle" alt="">
</p>

A Chrome extension that shows **the play count of every track** in the Spotify web
player — not just in the artist's top 10, but also in playlists, albums, and Liked
Songs.

## ⚡Features

- **Toggle on and off in one click.** Play counts can be hidden and shown from the
  popup — no uninstalling, no re-installing, no reloading the page.
- **Two placements that fit the layout.** The number can sit as a badge to the right
  of the track title, or be appended to the artists line under it
  (`Artist • 1 234 567`), where it reads as part of Spotify's own metadata.
- **Compact numbers.** Short formatting (`1.2M` instead of `1,234,567`) for when the
  exact figure matters less than the scale.

## 🛠️ Quick Start

1. Download or clone the `playcounts-for-spotify` folder.
2. Open `chrome://extensions/`.
3. Turn on **Developer mode** (the toggle in the top-right corner).
4. Click **Load unpacked** and select that folder.
5. Open (or reload) [open.spotify.com](https://open.spotify.com) — play counts
   appear next to the track names on album and playlist pages.

After changing the extension's files, click the reload icon on the extension card in
`chrome://extensions/` and refresh the Spotify tab.

## 🔎 How It Works

Spotify ships `playcount` for every track inside its GraphQL responses
(`https://api-partner.spotify.com/pathfinder/v2/query`), but renders that number only
in the artist's popular tracks block. The extension hooks those same responses,
remembers track → play count pairs, and appends the number to every row in the list.

The key point: **no third-party APIs and no tokens**. We never send requests to
Spotify ourselves — we only read what the browser has already loaded.
