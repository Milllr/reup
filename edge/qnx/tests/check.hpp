// The smallest test helper that works: CHECK counts failures, the program exits 1 if there were any.
#pragma once

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <vector>

#include "reup_math.hpp"

inline int g_failed = 0;
inline int g_checked = 0;

#define CHECK(cond)                                                      \
  do {                                                                   \
    ++g_checked;                                                         \
    if (!(cond)) {                                                       \
      ++g_failed;                                                        \
      std::printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond);        \
    }                                                                    \
  } while (0)

inline bool near(double a, double b, double eps = 1e-6) { return std::fabs(a - b) <= eps; }

inline int finish(const char* name) {
  std::printf("%s: %d checks, %d failed\n", name, g_checked, g_failed);
  return g_failed == 0 ? 0 : 1;
}

// A drawn board: wood, with a box in every pocket that is marked full.
struct Board {
  int w = 320, h = 240;
  std::vector<uint8_t> px;
  Board() : px(static_cast<size_t>(320) * 240 * 3) { fill_rect(0, 0, 1, 1, 96, 142, 178, 1.0); }
  void fill_rect(double x0, double y0, double x1, double y1, int b, int g, int r, double bright) {
    for (int y = static_cast<int>(y0 * h); y < static_cast<int>(y1 * h) && y < h; ++y)
      for (int x = static_cast<int>(x0 * w); x < static_cast<int>(x1 * w) && x < w; ++x) {
        uint8_t* p = &px[(static_cast<size_t>(y) * w + x) * 3];
        p[0] = static_cast<uint8_t>(b * bright), p[1] = static_cast<uint8_t>(g * bright), p[2] = static_cast<uint8_t>(r * bright);
      }
  }
  // Puts a box in pocket index of a zone whose quad is an upright rectangle. cover is how much of the pocket's width it fills.
  void box(const reup::Zone& z, int index, double cover = 1.0, int b = 40, int g = 60, int r = 200) {
    const double zw = z.quad[1].x - z.quad[0].x, zh = z.quad[3].y - z.quad[0].y;
    const int row = index / z.cols, col = index % z.cols;
    const double x0 = z.quad[0].x + zw * col / z.cols, y0 = z.quad[0].y + zh * row / z.rows;
    fill_rect(x0, y0, x0 + zw / z.cols * cover, y0 + zh / z.rows, b, g, r, 1.0);
  }
  void dim(double f) {
    for (uint8_t& v : px) v = static_cast<uint8_t>(v * f);
  }
  reup::Frame frame() const { return {px.data(), w, h, w * 3}; }
};

inline reup::Zone screws() {
  reup::Zone z;
  z.id = "z-screws", z.kind = "pockets", z.rows = 2, z.cols = 6;
  z.quad = {{{0.05, 0.1}, {0.65, 0.1}, {0.65, 0.5}, {0.05, 0.5}}};
  return z;
}
