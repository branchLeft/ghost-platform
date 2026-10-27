# media-kind.js

## What it decides

`classifyMediaKind(bytes)` answers `video-or-audio` or `other`, and
`detectVideoAudioFamily(bytes)` names the container family or answers `null`.
Both read the bytes only. A file name, a path or a declared type is never an
input, so renaming a video `x.png` or labelling it `image/png` changes
nothing. Nothing throws on an empty, short or truncated buffer, and nothing
is read past its end.

Only bytes the detector positively recognises as video or audio are
`video-or-audio`. Everything else, including bytes it cannot place, is
`other`. The decorator sends `other` to the existing check on every tier, so
unrecognised bytes are never refused for being unrecognised and never skipped
by the check (`tier-policy.md` and the README say what follows).

## What it recognises

| Family | Read from the bytes |
|---|---|
| `iso-base-media` | MP4, MOV, M4A, 3GP and kin: an `ftyp` box first, or a file with no `ftyp` that starts `moov`, `mdat`, `free`, `wide`, `skip` or `pnot` and holds a `moov` or `mdat` box |
| `matroska` | Matroska and WebM: the EBML header |
| `ogg` | Ogg: `OggS` (Vorbis, Opus, Theora, FLAC) |
| `mpeg-audio` | MP3 and other MPEG audio: a frame header at the start, or after any ID3v2 tags, followed by a second matching frame or the end of the file |
| `riff-wave`, `riff-avi` | `RIFF` with a `WAVE` or `AVI ` form type |
| `flac`, `iff-audio`, `adts`, `flv`, `asf`, `midi`, `amr`, `caf`, `wavpack`, `mpeg-program-stream`, `mpeg-video`, `mpeg-transport-stream` | their leading signatures; ADTS and transport streams need a repeating frame or packet pattern |

## Rulings in the code

- **Images that share the ISO container are images.** AVIF and HEIC use
  `ftyp` with image brands (`avif`, `heic`, `mif1`, `msf1` and the rest of
  the list in the source). A file with an image brand is video or audio only
  when its `moov` box holds a track whose handler is video or sound. A still
  image has no `moov`, and an animated image sequence has picture tracks, so
  both stay images; an MP4 that merely claims an image brand is caught.
  Any other brand, including an unknown one, is video or audio.
- **ID3v2 tags are skipped.** The declared size is read, a footer flag adds
  ten bytes, and up to eight tags are skipped, all bounds-checked. A tag
  that declares more than the file holds leaves nothing after it to match.
  FLAC, Ogg, MPEG audio and ADTS are recognised after the tags.
- **MPEG audio and ADTS are matched at the start only.** There is no scan
  for a frame sync later in the file: an MP3 with junk in front of its first
  frame is not recognised. A scan would add a false-positive rate on
  compressed data (zips, other binaries) that arbitrary files would pay, for
  a file most players would still resync.
- **Boxes are walked, not guessed.** A file that starts with a box other
  than `ftyp` is video only if its first box fits inside the file and is one
  of the leading types above. Text whose bytes 4 to 8 spell `free` or `moov`
  declares an impossible box size and is not a video.

## What it does not do

- It does not scan anything. It says what a file is, not whether it is safe.
- It does not recognise every video. A container outside the table (or one
  deliberately malformed so no signature matches) is `other` and gets only the
  existing check, which is not a video check.
- It does not tell video from audio; the tiers treat them alike.
- It treats an animated image sequence (`avis`, `heis`) as an image, which
  is what its brand says and its picture track confirms.
