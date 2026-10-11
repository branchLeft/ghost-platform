Byte-array identity cases for the PDQ port (src/pdq-hash.js).

Source: facebook/ThreatExchange, directory pdq/, commit
bd0108ff1745135a421856586d19d820dd62c6de.

pixel-cases.json holds numeric pixel arrays, produced by
test/helpers/pdq-pixels.mjs from fixed seeds, with the hash and quality the
reference hashing core (pdq/cpp/hashing/pdqhashing.cpp,
pdq/cpp/downscaling/downscaling.cpp, pdq/cpp/hashing/torben.cpp) printed for
exactly those bytes. No image file is involved. The reference's own
correctness test asks for this first: the same byte arrays into the reference
and into the port give the same hash.

Rebuild the expected values with reference-pixels-driver.cpp, built against a
checkout of the commit above without floating-point contraction:

  R=<checkout of the commit above>
  clang++ -O2 -ffp-contract=off -std=c++17 -I $R \
    $R/pdq/cpp/hashing/pdqhashing.cpp $R/pdq/cpp/hashing/torben.cpp \
    $R/pdq/cpp/downscaling/downscaling.cpp $R/pdq/cpp/common/pdqhashtypes.cpp \
    reference-pixels-driver.cpp -o pdq-ref-driver

The driver reads records of "WIDTH HEIGHT CHANNELS\n" then the raw bytes and
prints "hex quality" per record. Feed it the arrays from
test/helpers/pdq-pixels.mjs (PIXEL_CASES, plus the two flat cases named in
pixel-cases.json). With contraction on (the compiler's default on some
targets) one degenerate case, a flat image whose hash is rounding noise,
differs; no other case does.

The reference's licence (BSD) applies to the ported algorithm and its notice
is src/THIRD-PARTY-LICENSE-ThreatExchange-PDQ.txt. The images used elsewhere
in the tests are generated, not taken from the reference: see
../pdq-generated/README.txt.
