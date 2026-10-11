Reference data for the PDQ port (src/pdq-hash.js, src/pdq.js).

Source: facebook/ThreatExchange, directory pdq/, commit
bd0108ff1745135a421856586d19d820dd62c6de. LICENSE here is that repository's
root LICENSE (BSD), which is the licence the reference states for its files.
No licence file of its own sits in pdq/data; whether an individual image there
carries other terms is not stated.

images/ is a subset of pdq/data (reg-test-input/dih, reg-test-input/labelme-subset,
misc-images, bridge-mods), byte for byte. manifest.json records, for each file,
its sha256 and the hash and quality the reference's own photo hasher
(pdq/cpp/bin/pdq-photo-hasher.cpp, with CImg and libjpeg/libpng) printed for it.
For the eight reg-test-input/dih files these equal the hashes the reference
records in pdq/cpp/reg_test/expected/out (inReferenceRegressionExpected).

manifest.json pixelCases are synthetic pixel arrays (test/helpers/pdq-pixels.mjs)
with the hash and quality printed by the reference hashing core
(pdq/cpp/hashing/pdqhashing.cpp, pdq/cpp/downscaling/downscaling.cpp,
pdq/cpp/hashing/torben.cpp) run over exactly those bytes by
reference-pixels-driver.cpp, built without floating-point contraction:

  R=<checkout of the commit above>
  clang++ -O2 -ffp-contract=off -std=c++17 -I $R \
    $R/pdq/cpp/hashing/pdqhashing.cpp $R/pdq/cpp/hashing/torben.cpp \
    $R/pdq/cpp/downscaling/downscaling.cpp $R/pdq/cpp/common/pdqhashtypes.cpp \
    reference-pixels-driver.cpp -o pdq-ref-driver

The driver reads records of "WIDTH HEIGHT CHANNELS\n" then the raw bytes and
prints "hex quality" per record. With contraction on (the compiler's default
on some targets) one degenerate case, a flat image whose hash is rounding
noise, differs; no other case does.

Tolerances are the reference's own (pdq/README.md): quality >= 80 and within
distance 10 of its hash. A distance of 31 or less is its suggested starting
point for "the same picture"; the hash source does that matching here.
