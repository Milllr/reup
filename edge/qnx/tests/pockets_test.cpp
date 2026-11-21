// Host tests for the pocket math. CI compiles this with g++ and runs it. No QNX needed.
#include <sstream>

#include "check.hpp"

using namespace reup;

static std::vector<double> levels(const Board& now, const Board& empty, const Zone& z, bool correct = true) {
  Homography h;
  unit_to_quad(z.quad, h);
  const std::vector<Pt> border = border_points(FULL_FRAME, {z});
  const double g = correct ? gain(sample_all(now.frame(), border), sample_all(empty.frame(), border)) : 1.0;
  std::vector<double> out;
  for (int i = 0; i < z.pockets(); ++i) {
    const std::vector<Pt> pts = cell_points(h, z.rows, z.cols, i);
    out.push_back(level(sample_all(now.frame(), pts), sample_all(empty.frame(), pts), g));
  }
  return out;
}

int main() {
  // The flat rectangle maps onto the four corners of the quad.
  const Quad tilted{{{0.1, 0.2}, {0.7, 0.25}, {0.75, 0.8}, {0.05, 0.7}}};
  Homography h;
  CHECK(unit_to_quad(tilted, h));
  const double corners[4][2] = {{0, 0}, {1, 0}, {1, 1}, {0, 1}};
  for (int i = 0; i < 4; ++i) {
    const Pt p = h.apply(corners[i][0], corners[i][1]);
    CHECK(near(p.x, tilted[i].x) && near(p.y, tilted[i].y));
  }
  const Quad flat{{{0, 0}, {1, 0}, {1, 0}, {0, 0}}};
  CHECK(!unit_to_quad(flat, h));

  // Pockets are numbered row by row from the top left.
  const Zone z = screws();
  CHECK(unit_to_quad(z.quad, h));
  auto centre = [&](int index) {
    Pt c;
    const auto pts = cell_points(h, z.rows, z.cols, index);
    for (const Pt& p : pts) c.x += p.x / pts.size(), c.y += p.y / pts.size();
    return c;
  };
  CHECK(near(centre(0).x, 0.05 + 0.6 / 12, 1e-3) && near(centre(0).y, 0.2, 1e-3));
  CHECK(near(centre(5).x, 0.65 - 0.6 / 12, 1e-3) && near(centre(5).y, 0.2, 1e-3));
  CHECK(near(centre(6).x, centre(0).x, 1e-9) && near(centre(6).y, 0.4, 1e-3));
  CHECK(cell_points(h, 2, 6, 0, 10).size() == 100);

  // Occupancy on drawn buffers: empty, full, half covered, a sliver.
  const Board empty;
  Board now;
  now.box(z, 1);
  now.box(z, 2, 0.5);
  now.box(z, 3, 0.2);
  const auto l = levels(now, empty, z);
  CHECK(l[0] < 2);
  CHECK(l[1] > 60);
  CHECK(l[2] > 18 && l[2] < l[1]);
  CHECK(l[3] < 18);
  CHECK(!is_full(l[0], 18, false) && is_full(l[1], 18, false) && is_full(l[2], 18, false) && !is_full(l[3], 18, false));

  // A full pocket does not flicker near the threshold.
  CHECK(!is_full(17, 18, false) && is_full(17, 18, true) && !is_full(12, 18, true));

  // A box exactly as bright as the wood, but another colour, is still seen.
  Board grey_twin;
  grey_twin.box(z, 4, 1.0, 200, 150, 122);
  CHECK(levels(grey_twin, empty, z)[4] > 40);

  // Dimming the room by a third changes nothing once the brightness is corrected.
  Board dim = now;
  dim.dim(2.0 / 3.0);
  const auto corrected = levels(dim, empty, z), raw = levels(dim, empty, z, false);
  for (int i = 0; i < z.pockets(); ++i) CHECK(std::fabs(corrected[i] - l[i]) < 3.0);
  CHECK(raw[0] > 18);  // without the correction even an empty pocket looks full
  const auto border = border_points(FULL_FRAME, {z});
  CHECK(near(gain(sample_all(dim.frame(), border), sample_all(empty.frame(), border)), 1.5, 0.03));
  CHECK(near(gain({}, {}), 1.0));

  // Bare board points are outside every zone.
  CHECK(border.size() > 100);
  for (const Pt& p : border) CHECK(!point_in_quad(p, z.quad));
  CHECK(point_in_quad({0.4, 0.5}, tilted) && !point_in_quad({0.9, 0.5}, tilted));
  const Quad reversed{{tilted[3], tilted[2], tilted[1], tilted[0]}};
  CHECK(point_in_quad({0.4, 0.5}, reversed));

  // The zones file the guard writes.
  std::istringstream file(
      "# written by the guard\n"
      "zone z-screws pockets 2 6 0.05 0.1 0.65 0.1 0.65 0.5 0.05 0.5\n"
      "zone z-glue open 0 0 0.1 0.6 0.4 0.6 0.4 0.9 0.1 0.9\n"
      "zone z-broken pockets 2 2 0.1 0.1\n"
      "zone z-flat pockets 1 1 0 0 1 0 1 0 0 0\n"
      "nonsense\n");
  const auto zones = parse_zones(file);
  CHECK(zones.size() == 2);
  CHECK(zones[0].id == "z-screws" && zones[0].pockets() == 12 && near(zones[0].quad[2].x, 0.65));
  CHECK(zones[1].kind == "open" && zones[1].pockets() == 0);

  // Motion: the share of points that changed.
  Board moved = empty;
  moved.fill_rect(0.0, 0.0, 0.5, 1.0, 20, 20, 20, 1.0);
  const auto grid = grid_points(FULL_FRAME, 20);
  CHECK(near(motion(sample_all(moved.frame(), grid), sample_all(empty.frame(), grid)), 0.5, 0.03));
  CHECK(near(motion(sample_all(empty.frame(), grid), sample_all(empty.frame(), grid)), 0.0));
  return finish("pockets_test");
}
