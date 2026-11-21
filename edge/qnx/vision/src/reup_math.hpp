// reup shelf node: the plain math. Quads, pockets, brightness correction and reach timing.
// C++17, standard library only: no OpenCV, no QNX headers. The same rules as the eye (services/eye/reup_eye),
// so the Pi and the laptop agree on what a full pocket is. Host tests: edge/qnx/tests/*_test.cpp.
#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <istream>
#include <sstream>
#include <string>
#include <vector>

namespace reup {

struct Pt {
  double x = 0, y = 0;
};
using Quad = std::array<Pt, 4>;  // clockwise from the top left, normalized 0..1

inline constexpr Quad FULL_FRAME{{{0, 0}, {1, 0}, {1, 1}, {0, 1}}};

// Maps the flat rectangle (0..1 by 0..1) onto a quad.
struct Homography {
  double m[9] = {1, 0, 0, 0, 1, 0, 0, 0, 1};
  Pt apply(double u, double v) const {
    const double w = m[6] * u + m[7] * v + m[8];
    return {(m[0] * u + m[1] * v + m[2]) / w, (m[3] * u + m[4] * v + m[5]) / w};
  }
};

// False when the quad is not a real four sided shape.
inline bool unit_to_quad(const Quad& q, Homography& out) {
  static const double src[4][2] = {{0, 0}, {1, 0}, {1, 1}, {0, 1}};
  double a[8][9];
  for (int i = 0; i < 4; ++i) {
    const double x = src[i][0], y = src[i][1], u = q[i].x, v = q[i].y;
    const double r1[9] = {x, y, 1, 0, 0, 0, -u * x, -u * y, u};
    const double r2[9] = {0, 0, 0, x, y, 1, -v * x, -v * y, v};
    std::copy(r1, r1 + 9, a[2 * i]);
    std::copy(r2, r2 + 9, a[2 * i + 1]);
  }
  for (int col = 0; col < 8; ++col) {
    int pivot = col;
    for (int r = col + 1; r < 8; ++r)
      if (std::fabs(a[r][col]) > std::fabs(a[pivot][col])) pivot = r;
    if (std::fabs(a[pivot][col]) < 1e-12) return false;
    std::swap_ranges(a[col], a[col] + 9, a[pivot]);
    for (int r = 0; r < 8; ++r) {
      if (r == col) continue;
      const double f = a[r][col] / a[col][col];
      for (int c = col; c < 9; ++c) a[r][c] -= f * a[col][c];
    }
  }
  for (int i = 0; i < 8; ++i) out.m[i] = a[i][8] / a[i][i];
  out.m[8] = 1;
  return true;
}

inline bool point_in_quad(Pt p, const Quad& q) {
  bool pos = true, neg = true;
  for (int i = 0; i < 4; ++i) {
    const Pt a = q[i], b = q[(i + 1) % 4];
    const double s = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    pos = pos && s >= 0;
    neg = neg && s <= 0;
  }
  return pos || neg;
}

inline Quad expand(const Quad& q, double factor) {
  Pt c{0, 0};
  for (const Pt& p : q) c.x += p.x / 4, c.y += p.y / 4;
  Quad out;
  for (int i = 0; i < 4; ++i) out[i] = {c.x + (q[i].x - c.x) * factor, c.y + (q[i].y - c.y) * factor};
  return out;
}

struct Zone {
  std::string id;
  std::string kind;  // pockets, open or bin
  int rows = 0, cols = 0;
  Quad quad = FULL_FRAME;
  int pockets() const { return kind == "pockets" ? rows * cols : 0; }
};

// The file the guard writes. One line a zone: zone <id> <kind> <rows> <cols> <eight numbers>. Other lines are skipped.
inline std::vector<Zone> parse_zones(std::istream& in) {
  std::vector<Zone> zones;
  std::string line;
  while (std::getline(in, line)) {
    std::istringstream row(line);
    std::string word;
    Zone z;
    if (!(row >> word) || word != "zone") continue;
    if (!(row >> z.id >> z.kind >> z.rows >> z.cols)) continue;
    bool ok = true;
    for (Pt& p : z.quad) ok = ok && static_cast<bool>(row >> p.x >> p.y);
    Homography h;
    if (ok && unit_to_quad(z.quad, h)) zones.push_back(z);
  }
  return zones;
}

// n by n points inside one pocket, away from its walls. Pockets are numbered row by row from the top left.
inline std::vector<Pt> cell_points(const Homography& h, int rows, int cols, int index, int n = 10, double inset = 0.18) {
  const int r = index / cols, c = index % cols;
  std::vector<Pt> pts;
  pts.reserve(static_cast<size_t>(n) * n);
  for (int j = 0; j < n; ++j)
    for (int i = 0; i < n; ++i) {
      const double fu = inset + (1 - 2 * inset) * (i + 0.5) / n, fv = inset + (1 - 2 * inset) * (j + 0.5) / n;
      pts.push_back(h.apply((c + fu) / cols, (r + fv) / rows));
    }
  return pts;
}

inline std::vector<Pt> grid_points(const Quad& q, int n) {
  std::vector<Pt> pts;
  Homography h;
  if (!unit_to_quad(q, h)) return pts;
  for (int j = 0; j < n; ++j)
    for (int i = 0; i < n; ++i) pts.push_back(h.apply((i + 0.5) / n, (j + 0.5) / n));
  return pts;
}

// Points on bare board: inside the board, outside every zone. They show how bright the room is.
inline std::vector<Pt> border_points(const Quad& board, const std::vector<Zone>& zones, int n = 24, double margin = 1.12) {
  std::vector<Pt> out;
  for (const Pt& p : grid_points(board, n)) {
    bool inside = false;
    for (const Zone& z : zones) inside = inside || point_in_quad(p, expand(z.quad, margin));
    if (!inside) out.push_back(p);
  }
  return out;
}

// A picture: 8 bit, three channels a pixel, rows stride bytes apart.
struct Frame {
  const uint8_t* data = nullptr;
  int w = 0, h = 0, stride = 0;
  bool ok() const { return data != nullptr && w > 2 && h > 2; }
};

struct Colour {
  float c[3] = {0, 0, 0};
  float mean() const { return (c[0] + c[1] + c[2]) / 3.0f; }
};

// The colour at a normalized point, averaged over 3 by 3 pixels. The averaging is the blur.
inline Colour sample(const Frame& f, Pt p) {
  const int x = std::clamp(static_cast<int>(std::lround(p.x * (f.w - 1))), 1, f.w - 2);
  const int y = std::clamp(static_cast<int>(std::lround(p.y * (f.h - 1))), 1, f.h - 2);
  int sum[3] = {0, 0, 0};
  for (int dy = -1; dy <= 1; ++dy) {
    const uint8_t* row = f.data + static_cast<ptrdiff_t>(y + dy) * f.stride + (x - 1) * 3;
    for (int dx = 0; dx < 3; ++dx)
      for (int k = 0; k < 3; ++k) sum[k] += row[dx * 3 + k];
  }
  return {{sum[0] / 9.0f, sum[1] / 9.0f, sum[2] / 9.0f}};
}

inline std::vector<Colour> sample_all(const Frame& f, const std::vector<Pt>& pts) {
  std::vector<Colour> out;
  out.reserve(pts.size());
  for (const Pt& p : pts) out.push_back(sample(f, p));
  return out;
}

// How much brighter the reference is than now, measured on bare board. Multiply the current picture by it.
inline double gain(const std::vector<Colour>& now, const std::vector<Colour>& ref) {
  if (now.size() < 8 || now.size() != ref.size()) return 1.0;
  auto median = [](const std::vector<Colour>& v) {
    std::vector<float> m;
    m.reserve(v.size());
    for (const Colour& c : v) m.push_back(c.mean());
    std::nth_element(m.begin(), m.begin() + m.size() / 2, m.end());
    return static_cast<double>(m[m.size() / 2]);
  };
  const double n = median(now);
  if (n < 1.0) return 1.0;
  return std::clamp(median(ref) / n, 0.4, 2.5);
}

inline float difference(const Colour& now, const Colour& ref, double g) {
  float d = 0;
  for (int k = 0; k < 3; ++k) d = std::max(d, std::fabs(static_cast<float>(now.c[k] * g) - ref.c[k]));
  return d;
}

// Mean difference from the empty board over one pocket's samples. The biggest of the three channels counts.
inline double level(const std::vector<Colour>& now, const std::vector<Colour>& ref, double g = 1.0) {
  if (now.empty() || now.size() != ref.size()) return 0.0;
  double sum = 0;
  for (size_t i = 0; i < now.size(); ++i) sum += difference(now[i], ref[i], g);
  return sum / static_cast<double>(now.size());
}

// A pocket is full over the threshold. One that was full stays full until it drops well under it.
inline bool is_full(double lvl, double threshold, bool was_full, double hysteresis = 0.7) {
  return lvl > threshold * (was_full ? hysteresis : 1.0);
}

// The share of points that changed by more than pixel since the last look.
inline double motion(const std::vector<Colour>& now, const std::vector<Colour>& before, double pixel = 14.0) {
  if (now.empty() || now.size() != before.size()) return 0.0;
  size_t moved = 0;
  for (size_t i = 0; i < now.size(); ++i) moved += difference(now[i], before[i], 1.0) > pixel ? 1 : 0;
  return static_cast<double>(moved) / static_cast<double>(now.size());
}

// A reach: a hand over the board. It starts when a hand is seen on start_frames frames in a row, so one false
// detection is not a reach. It ends after end_ms with no hand, so a hand lost for a frame does not end it.
class ReachTracker {
 public:
  enum class Event { None, Start, End };
  explicit ReachTracker(int end_ms = 400, int start_frames = 2) : end_ms_(end_ms), start_frames_(start_frames) {}

  Event update(bool hand, const std::string& zone, int64_t t_ms) {
    if (hand) {
      last_seen_ = t_ms;
      ++seen_run_;
      if (!zone.empty()) zone_ = zone;
      if (!active_ && seen_run_ >= start_frames_) {
        active_ = true;
        return Event::Start;
      }
      return Event::None;
    }
    seen_run_ = 0;
    if (active_ && t_ms - last_seen_ >= end_ms_) {
      active_ = false;
      ended_at_ = t_ms;
      return Event::End;
    }
    if (!active_) zone_.clear();
    return Event::None;
  }

  bool active() const { return active_; }
  int64_t ended_at() const { return ended_at_; }
  // The zone the hand was last over, or empty when it was over none. Valid for the Start and the End event.
  const std::string& zone() const { return zone_; }
  void clear_zone() { zone_.clear(); }

 private:
  int end_ms_, start_frames_;
  bool active_ = false;
  int seen_run_ = 0;
  int64_t last_seen_ = 0, ended_at_ = -1000000;
  std::string zone_;
};

}  // namespace reup
