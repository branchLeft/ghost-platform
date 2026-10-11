// Hashes raw pixel buffers with the reference hashing core (see README.txt).
// Input on stdin per record: "W H C\n" then W*H*C raw bytes. Output: "hex quality\n".
#include <pdq/cpp/common/pdqhashtypes.h>
#include <pdq/cpp/downscaling/downscaling.h>
#include <pdq/cpp/hashing/pdqhashing.h>
#include <cstdio>
#include <cstdlib>
#include <vector>
using namespace facebook::pdq;
int main() {
  int w, h, c;
  while (scanf("%d %d %d", &w, &h, &c) == 3) {
    fgetc(stdin);
    std::vector<uint8_t> px((size_t)w * h * c);
    if (fread(px.data(), 1, px.size(), stdin) != px.size()) return 2;
    std::vector<float> b1((size_t)w * h), b2((size_t)w * h);
    if (c == 3) {
      downscaling::fillFloatLumaFromRGB(px.data(), px.data() + 1, px.data() + 2, h, w, 3 * w, 3, b1.data());
    } else {
      downscaling::fillFloatLumaFromGrey(px.data(), h, w, w, 1, b1.data());
    }
    float b64[64][64], b1664[16][64], b1616[16][16];
    hashing::Hash256 hash;
    int quality = 0;
    hashing::pdqHash256FromFloatLuma(b1.data(), b2.data(), h, w, b64, b1664, b1616, hash, quality);
    printf("%s %d\n", hash.format().c_str(), quality);
  }
  return 0;
}
