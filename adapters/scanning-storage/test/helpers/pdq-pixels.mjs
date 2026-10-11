// Deterministic pixel buffers for the PDQ port's exactness test. The same
// function produced the inputs the C++ reference was run on (see
// test/fixtures/pdq-reference/README.txt), so the recorded hashes line up.

function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state >>> 24;
  };
}

// `kind: 'blocks'` is blocky content plus low-amplitude noise, so the DCT is
// not degenerate; `kind: 'flat'` is one value everywhere.
export function syntheticPixels({ width, height, channels, seed, kind }) {
  const pixels = Buffer.alloc(width * height * channels);
  if (kind === 'flat') {
    pixels.fill(seed & 255);
    return pixels;
  }
  const noise = lcg(seed);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      for (let k = 0; k < channels; k += 1) {
        const block = (Math.floor(x / 9) * 37 + Math.floor(y / 7) * 91 + k * 50) & 255;
        pixels[(y * width + x) * channels + k] = block ^ (noise() & 15);
      }
    }
  }
  return pixels;
}

export const PIXEL_CASES = (() => {
  const dims = [
    [5, 5],
    [7, 9],
    [64, 64],
    [63, 65],
    [100, 37],
    [128, 128],
    [257, 300],
    [512, 512],
    [300, 700],
    [1000, 333],
    [640, 480],
  ];
  const cases = [];
  let seed = 1;
  for (const [width, height] of dims) {
    for (const channels of [3, 1]) {
      cases.push({
        name: `blocks-${width}x${height}x${channels}`,
        width,
        height,
        channels,
        seed,
        kind: 'blocks',
      });
      seed += 1;
    }
  }
  return cases;
})();
