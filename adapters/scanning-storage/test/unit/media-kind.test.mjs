import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import * as bytes from '../helpers/media-bytes.mjs';

const require = createRequire(import.meta.url);
const {
  MEDIA_KIND,
  classifyMediaKind,
  detectVideoAudioFamily,
} = require('../../src/media-kind.js');

const VIDEO_OR_AUDIO_FIXTURES = [
  ['an MP4 (isom)', () => bytes.mp4Bytes('isom')],
  ['an MP4 (mp42)', () => bytes.mp4Bytes('mp42')],
  ['a QuickTime movie', () => bytes.quickTimeBytes()],
  ['an M4A', () => bytes.m4aBytes()],
  ['a 3GP', () => bytes.threeGpBytes()],
  ['an MP4 with an unknown brand', () => bytes.mp4Bytes('zzzz')],
  ['a QuickTime movie with no ftyp, starting wide', () => bytes.quickTimeWithoutFileTypeBytes()],
  ['a movie with no ftyp, starting moov', () => bytes.moovFirstWithoutFileTypeBytes()],
  ['a video that claims the avif brand', () => bytes.videoWithImageBrandBytes('avif')],
  ['a video that claims the heic brand', () => bytes.videoWithImageBrandBytes('heic')],
  ['a video that claims the avis brand', () => bytes.videoWithImageBrandBytes('avis')],
  ['a WebM', () => bytes.webmBytes()],
  ['a Matroska file', () => bytes.matroskaBytes()],
  ['an Ogg stream', () => bytes.oggBytes()],
  ['an MP3 with no tag', () => bytes.mp3Bytes()],
  ['an MP3 with one frame only', () => bytes.mp3Bytes(1)],
  ['an MP3 with an ID3 tag', () => bytes.mp3WithId3Bytes()],
  ['an MP3 with an ID3 tag and footer', () => bytes.mp3WithId3Bytes({ hasFooter: true })],
  ['an MP3 with an empty ID3 body', () => bytes.mp3WithId3Bytes({ bodyLength: 0 })],
  [
    'an MP3 with two ID3 tags',
    () => Buffer.concat([bytes.id3Tag(40), bytes.id3Tag(40), bytes.mp3Bytes()]),
  ],
  ['a WAV', () => bytes.wavBytes()],
  ['an AVI', () => bytes.aviBytes()],
  ['a FLAC', () => bytes.flacBytes()],
  ['a FLAC behind an ID3 tag', () => Buffer.concat([bytes.id3Tag(40), bytes.flacBytes()])],
  ['an AIFF', () => bytes.aiffBytes()],
  ['an AAC stream in ADTS framing', () => bytes.adtsBytes()],
  ['an AAC stream behind an ID3 tag', () => Buffer.concat([bytes.id3Tag(40), bytes.adtsBytes()])],
  ['an FLV', () => bytes.flvBytes()],
  ['an ASF', () => bytes.asfBytes()],
  ['a MIDI file', () => bytes.midiBytes()],
  ['an MPEG program stream', () => bytes.mpegProgramStreamBytes()],
  ['an MPEG transport stream', () => bytes.transportStreamBytes()],
  ['an MPEG transport stream with 4-byte timestamps', () => bytes.transportStreamBytes(5, 192, 4)],
];

const NOT_VIDEO_OR_AUDIO_FIXTURES = [
  ['empty bytes', () => Buffer.alloc(0)],
  ['a PDF', () => bytes.pdfBytes()],
  ['a zip', () => bytes.zipBytes()],
  ['plain text', () => bytes.textBytes()],
  ['text with ftyp at offset 4', () => bytes.textBytes('abcdftyp isom is just text here')],
  ['text with moov at offset 4', () => bytes.textBytes('abcdmoov is just text here, too')],
  ['text with mdat at offset 4', () => bytes.textBytes('abcdmdat is just text here, too')],
  ['text with free at offset 4', () => bytes.textBytes('abcdfree is just text here, too')],
  ['text starting with G', () => bytes.textBytes(`G${'x'.repeat(700)}`)],
  ['a PNG', () => bytes.pngBytes()],
  ['a JPEG', () => bytes.jpegBytes()],
  ['a GIF', () => bytes.gifBytes()],
  ['a bitmap', () => bytes.bitmapBytes()],
  ['a WebP', () => bytes.webpBytes()],
  ['an IFF image', () => bytes.interchangeBitmapBytes()],
  ['a still AVIF', () => bytes.stillImageBytes('avif')],
  ['a still HEIC', () => bytes.stillImageBytes('heic')],
  ['a still HEIF (mif1)', () => bytes.stillImageBytes('mif1')],
  ['an animated AVIF (avis)', () => bytes.imageSequenceBytes('avis')],
  ['an animated HEIC sequence (heis)', () => bytes.imageSequenceBytes('heis')],
  ['an ID3 tag with nothing after it', () => bytes.id3OnlyBytes()],
  ['a lone free box', () => bytes.box('free', Buffer.alloc(16))],
  ['a lone sync byte pair', () => Buffer.from([0xff, 0xfb])],
  ['an ID3 tag that declares more than the file holds', () => bytes.id3Tag(4000).subarray(0, 100)],
];

describe('classifyMediaKind', () => {
  it.each(VIDEO_OR_AUDIO_FIXTURES)('classifies %s as video or audio', (_label, build) => {
    expect(classifyMediaKind(build())).toBe(MEDIA_KIND.VIDEO_OR_AUDIO);
    expect(detectVideoAudioFamily(build())).toEqual(expect.any(String));
  });

  it.each(NOT_VIDEO_OR_AUDIO_FIXTURES)('classifies %s as not video or audio', (_label, build) => {
    expect(classifyMediaKind(build())).toBe(MEDIA_KIND.OTHER);
    expect(detectVideoAudioFamily(build())).toBeNull();
  });

  it('names the container family it recognised', () => {
    expect(detectVideoAudioFamily(bytes.mp4Bytes())).toBe('iso-base-media');
    expect(detectVideoAudioFamily(bytes.webmBytes())).toBe('matroska');
    expect(detectVideoAudioFamily(bytes.oggBytes())).toBe('ogg');
    expect(detectVideoAudioFamily(bytes.mp3WithId3Bytes())).toBe('mpeg-audio');
    expect(detectVideoAudioFamily(bytes.wavBytes())).toBe('riff-wave');
    expect(detectVideoAudioFamily(bytes.aviBytes())).toBe('riff-avi');
    expect(detectVideoAudioFamily(bytes.flacBytes())).toBe('flac');
  });

  it.each([0, 1, 2, 3, 4, 7, 8, 11, 12])(
    'does not throw on any prefix of %i bytes of every fixture',
    (length) => {
      for (const [, build] of [...VIDEO_OR_AUDIO_FIXTURES, ...NOT_VIDEO_OR_AUDIO_FIXTURES]) {
        expect(() => classifyMediaKind(build().subarray(0, length))).not.toThrow();
      }
    }
  );

  it('does not throw on every truncation of a video, and never reads past the buffer', () => {
    for (const [, build] of VIDEO_OR_AUDIO_FIXTURES) {
      const whole = build();
      for (let length = 0; length <= whole.length; length += 1) {
        expect(() => classifyMediaKind(whole.subarray(0, length))).not.toThrow();
      }
    }
  });

  it('still recognises a video that was cut short after its first boxes', () => {
    const whole = bytes.mp4Bytes();
    expect(classifyMediaKind(whole.subarray(0, whole.length - 10))).toBe(MEDIA_KIND.VIDEO_OR_AUDIO);
  });

  it('does not throw on an ISO box that declares a size larger than the file', () => {
    const lying = Buffer.concat([bytes.box('ftyp', Buffer.from('isom\0\0\0\0')).subarray(0, 8)]);
    lying.writeUInt32BE(0xffffffff, 0);
    expect(() => classifyMediaKind(lying)).not.toThrow();
  });

  it('reads a 64-bit box size without throwing', () => {
    const header = Buffer.alloc(16);
    header.writeUInt32BE(1, 0);
    header.write('mdat', 4, 'latin1');
    header.writeBigUInt64BE(BigInt(16 + 20), 8);
    const withLargeBox = Buffer.concat([
      bytes.box('wide'),
      header,
      Buffer.alloc(20),
      bytes.box('moov'),
    ]);
    expect(classifyMediaKind(withLargeBox)).toBe(MEDIA_KIND.VIDEO_OR_AUDIO);
  });

  it('reads a box that runs to the end of the file (size zero)', () => {
    const toEnd = Buffer.concat([
      bytes.box('wide'),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from('mdat'),
      Buffer.alloc(20),
    ]);
    expect(classifyMediaKind(toEnd)).toBe(MEDIA_KIND.VIDEO_OR_AUDIO);
  });

  it('does not throw on a 64-bit box header cut off inside its size field', () => {
    const header = Buffer.alloc(12);
    header.writeUInt32BE(1, 0);
    header.write('mdat', 4, 'latin1');
    expect(classifyMediaKind(header)).toBe(MEDIA_KIND.OTHER);
  });

  it('rejects a box whose 64-bit size is smaller than its own header', () => {
    const header = Buffer.alloc(16);
    header.writeUInt32BE(1, 0);
    header.write('mdat', 4, 'latin1');
    header.writeBigUInt64BE(4n, 8);
    expect(classifyMediaKind(Buffer.concat([header, Buffer.alloc(20)]))).toBe(MEDIA_KIND.OTHER);
  });

  it('accepts a Uint8Array view of the bytes', () => {
    const view = new Uint8Array(bytes.mp4Bytes());
    expect(classifyMediaKind(view)).toBe(MEDIA_KIND.VIDEO_OR_AUDIO);
  });

  it.each([undefined, null, 'ftypisom', 42, {}])(
    'treats the non-buffer %j as not video or audio',
    (input) => {
      expect(classifyMediaKind(input)).toBe(MEDIA_KIND.OTHER);
    }
  );

  it('does not take an ID3 tag with a non-syncsafe size as a tag', () => {
    const broken = bytes.mp3WithId3Bytes();
    broken[6] = 0xff;
    expect(classifyMediaKind(broken)).toBe(MEDIA_KIND.OTHER);
  });

  it('does not take a lone MPEG-audio-looking header followed by something else as audio', () => {
    const header = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(2000, 0x41)]);
    expect(classifyMediaKind(header)).toBe(MEDIA_KIND.OTHER);
  });

  it.each([
    ['reserved version', Buffer.from([0xff, 0xe9, 0x90, 0x00])],
    ['reserved layer', Buffer.from([0xff, 0xf9, 0x90, 0x00])],
    ['free-format bitrate', Buffer.from([0xff, 0xfb, 0x00, 0x00])],
    ['bad bitrate', Buffer.from([0xff, 0xfb, 0xf0, 0x00])],
    ['bad sample rate', Buffer.from([0xff, 0xfb, 0x9c, 0x00])],
  ])('rejects an MPEG audio header with a %s', (_label, header) => {
    expect(classifyMediaKind(Buffer.concat([header, Buffer.alloc(2000)]))).toBe(MEDIA_KIND.OTHER);
  });

  it('recognises MPEG-2 Layer III and MPEG-1 Layer I and II headers', () => {
    const mpeg2Layer3 = Buffer.from([0xff, 0xf3, 0x80, 0x00]);
    const mpeg1Layer1 = Buffer.from([0xff, 0xff, 0x90, 0x00]);
    const mpeg1Layer2 = Buffer.from([0xff, 0xfd, 0x90, 0x00]);
    for (const header of [mpeg2Layer3, mpeg1Layer1, mpeg1Layer2]) {
      expect(classifyMediaKind(header)).toBe(MEDIA_KIND.VIDEO_OR_AUDIO);
    }
  });

  it('does not take sync bytes at one stride only as a transport stream', () => {
    const twoPackets = bytes.transportStreamBytes(2);
    expect(classifyMediaKind(twoPackets)).toBe(MEDIA_KIND.OTHER);
  });

  it('does not take an ISO file with a moov box of picture tracks only as video', () => {
    expect(classifyMediaKind(bytes.imageSequenceBytes('avis'))).toBe(MEDIA_KIND.OTHER);
  });
});
