Generated pictures for the PDQ tests.

Every file here is computed by generate.mjs from formulas and one fixed seed
(SEED in that file). They are gradients, shapes, seeded noise and dithering:
no photograph, no third-party artwork, nothing taken from the reference's
data. They can be rebuilt, byte for byte for the PNG files and pixel for pixel
for the lossless ones, with:

  node generate.mjs            # writes the pictures (needs sharp)
  node generate.mjs --verify   # checks the lossless files decode to the
                               # generated pixels exactly

What each picture is for (the generator is the single source for all of it):

  scene-a-256x192.png          lossless; seeded noise; no shrinking
  scene-a-480x360.jpg          the same scene as a JPEG, quality 90
  scene-a-small-240x180.jpg    a resized (half size) and recompressed
                               (quality 50) copy of scene-a: the "same
                               picture" control
  scene-a-large-1280x960.jpg   over 512 px: shrunk before hashing
  scene-b-256x192.png          rings and stripes: the "unrelated" control
  scene-c-256x192.gif          eight flat colours, GIF
  scene-c-256x192.webp         the same, lossless WebP
  bilevel-1600x1000.png        one bit per pixel, error-diffused, over
                               512 px: the case where the shrinking filter
                               matters (nearest-neighbour is further from
                               the reference than Lanczos)
  flat-64x64.png               one colour: quality 0
  contrast-NN-128x128.png      amplitude NN; the reference reports quality
                               0, 24, 49, 54, 77, 82, 100 for 04, 08, 12,
                               13, 17, 18, 22: either side of its 49 (discard)
                               and 80 (tolerance) marks
  ../clean.png, ../bad.png     the two pictures the adapter tests upload

manifest.json records, for each picture, its sha256 and what the reference
implementation says about it, with the reference commit
bd0108ff1745135a421856586d19d820dd62c6de and the generator seed. It is
written by record-reference.mjs, which needs two tools built from a checkout
of that commit:

  1. pdq-ref-driver: the reference hashing core over raw pixel arrays. Build
     it as described in ../pdq-reference/README.txt.
  2. pdq-photo-hasher: the reference's own tool, built with CImg and
     libjpeg/libpng:

       R=<checkout of the commit above>
       clang++ -O2 -ffp-contract=off -std=c++17 -I $R -I $R/pdq/cpp \
         -Dcimg_use_jpeg -Dcimg_use_png -Dcimg_display=0 \
         $R/pdq/cpp/bin/pdq-photo-hasher.cpp $R/pdq/cpp/io/pdqio.cpp \
         $R/pdq/cpp/io/hashio.cpp $R/pdq/cpp/hashing/pdqhashing.cpp \
         $R/pdq/cpp/hashing/torben.cpp $R/pdq/cpp/downscaling/downscaling.cpp \
         $R/pdq/cpp/common/pdqhashtypes.cpp $R/pdq/cpp/common/pdqhamming.cpp \
         $R/pdq/cpp/common/pdqutils.cpp -ljpeg -lpng -lz -o pdq-photo-hasher

then:

  node record-reference.mjs ./pdq-ref-driver ./pdq-photo-hasher

JPEG and PNG pictures are hashed by pdq-photo-hasher (the whole reference
pipeline, including its shrink to 512 x 512). GIF and WebP, which it cannot
read, are hashed by the core over the generator's own pixels: valid because
both are lossless and no larger than 512 px. For lossless PNGs of 512 px or
less both are recorded, and they agree.

Tolerances are the reference's (pdq/README.md): identical byte arrays give the
identical hash; decoded images at quality >= 80 are within distance 10; a
distance of 31 or less is its suggested starting point for "the same picture".
