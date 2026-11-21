// Host test for the whole vision side: drawn frames in, JSON lines out, files on disk.
#include <filesystem>
#include <fstream>
#include <sstream>

#include "check.hpp"
#include "reup_vision.hpp"

using namespace reup;
namespace fs = std::filesystem;

static std::string fixed_clock() { return "2026-11-21T09:14:03-05:00"; }

static std::vector<std::string> lines(std::ostringstream& out) {
  std::vector<std::string> v;
  std::istringstream in(out.str());
  for (std::string line; std::getline(in, line);) v.push_back(line);
  out.str("");
  return v;
}

static bool has(const std::vector<std::string>& v, const std::string& part) {
  for (const auto& s : v)
    if (s.find(part) != std::string::npos) return true;
  return false;
}

int main() {
  const fs::path dir = fs::temp_directory_path() / ("reup-vision-test-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
  fs::create_directories(dir);
  { std::ofstream(dir / "zones.txt") << "zone z-screws pockets 2 6 0.05 0.1 0.65 0.1 0.65 0.5 0.05 0.5\n"; }
  const Zone z = screws();
  VisionConfig cfg;
  cfg.dir = dir.string();
  std::ostringstream out;
  int64_t t = 0;
  const Board empty;
  Board six;
  for (int i = 0; i < 6; ++i) six.box(z, i);
  Board four;
  for (int i = 0; i < 4; ++i) four.box(z, i);

  {
    Vision v(cfg, out, fixed_clock);
    auto run = [&](const Board& b, int ms, const Pt* hand = nullptr) {
      for (int end = static_cast<int>(t) + ms; t < end; t += 33) v.on_frame(hand, hand ? 1 : 0, b.frame(), t);
    };

    // No empty board saved yet: it says so, and reaches still work.
    run(empty, 1200);
    auto got = lines(out);
    CHECK(got.size() == 1 && got[0] == "{\"type\":\"hello\",\"pockets\":false,\"model\":false,\"zones\":1}");
    const Pt over_screws{0.3, 0.3};
    run(empty, 300, &over_screws);
    run(empty, 600);
    got = lines(out);
    CHECK(got.size() == 2);
    CHECK(got[0] == "{\"type\":\"reach\",\"state\":\"start\",\"zone\":\"z-screws\",\"ts\":\"2026-11-21T09:14:03-05:00\"}");
    CHECK(got[1] == "{\"type\":\"reach\",\"state\":\"end\",\"zone\":\"z-screws\",\"ts\":\"2026-11-21T09:14:03-05:00\"}");
    const Pt off_zone{0.9, 0.9};
    run(empty, 200, &off_zone);
    run(empty, 600);
    got = lines(out);
    CHECK(got.size() == 2 && has(got, "\"zone\":null"));

    // capture_reference.sh makes the flag: the empty board is saved and pockets come alive.
    { std::ofstream(dir / "capture.flag") << "1"; }
    run(empty, 1200);
    got = lines(out);
    CHECK(has(got, "\"type\":\"hello\",\"pockets\":true"));
    CHECK(has(got, "\"type\":\"reference\",\"ok\":true"));
    CHECK(!fs::exists(dir / "capture.flag") && fs::file_size(dir / "reference.bgr") > 320 * 240 * 3);
    // The first still look reports every pocket zone, here all empty.
    CHECK(has(got, "{\"type\":\"pockets\",\"zone\":\"z-screws\",\"pockets\":[false,false,false,false,false,false,false,false,false,false,false,false]"));
    // Six boxes go in. A hand is over the board while they do: nothing is read until it has left and all is still.
    run(six, 400, &over_screws);
    got = lines(out);
    CHECK(has(got, "\"state\":\"start\"") && !has(got, "\"type\":\"pockets\""));
    const int64_t left = t;
    run(six, 300);
    CHECK(!has(lines(out), "\"type\":\"pockets\""));  // the reach has not even ended yet
    run(six, 1200);
    got = lines(out);
    CHECK(has(got, "\"state\":\"end\""));
    CHECK(has(got, "\"pockets\":[true,true,true,true,true,true,false,false,false,false,false,false]"));
    (void)left;

    // Two are taken. The new state is reported once, and not again while nothing changes.
    run(four, 300, &over_screws);
    run(four, 1500);
    got = lines(out);
    CHECK(has(got, "\"pockets\":[true,true,true,true,false,false,false,false,false,false,false,false]"));
    run(four, 3000);
    CHECK(lines(out).empty());

    // The lights go down by a third with nobody near: a reach never happened, so nothing is read and nothing is said.
    Board dim = four;
    dim.dim(2.0 / 3.0);
    run(dim, 2000);
    CHECK(!has(lines(out), "\"type\":\"pockets\""));
    // A hand comes and goes in the dim room and takes nothing: the pockets are read again and are unchanged.
    run(dim, 300, &over_screws);
    run(dim, 1500);
    CHECK(!has(lines(out), "\"type\":\"pockets\""));

    // snapshot.sh makes a flag: the picture is written for finding the zone corners.
    { std::ofstream(dir / "snapshot.flag") << "1"; }
    run(four, 1200);
    std::ifstream ppm(dir / "snapshot.ppm", std::ios::binary);
    std::string magic;
    int w = 0, h = 0;
    ppm >> magic >> w >> h;
    CHECK(magic == "P6" && w == 320 && h == 240 && fs::file_size(dir / "snapshot.ppm") > 320 * 240 * 3);
    lines(out);
  }

  // Vision is killed and started again: the empty board is still on disk and the pockets are reported again.
  {
    Vision v(cfg, out, fixed_clock);
    for (int end = static_cast<int>(t) + 1500; t < end; t += 33) v.on_frame(nullptr, 0, four.frame(), t);
    const auto got = lines(out);
    CHECK(has(got, "\"type\":\"hello\",\"pockets\":true"));
    CHECK(has(got, "\"pockets\":[true,true,true,true,false,false,false,false,false,false,false,false]"));
    // The guard rewrites zones.txt: vision picks it up within a second or so.
    fs::last_write_time(dir / "zones.txt", fs::last_write_time(dir / "zones.txt") + std::chrono::seconds(5));
    { std::ofstream(dir / "zones.txt") << "zone z-screws pockets 1 6 0.05 0.1 0.65 0.1 0.65 0.3 0.05 0.3\n"; }
    fs::last_write_time(dir / "zones.txt", fs::last_write_time(dir / "zones.txt") + std::chrono::seconds(9));
    for (int end = static_cast<int>(t) + 2500; t < end; t += 33) v.on_frame(nullptr, 0, four.frame(), t);
    const auto after = lines(out);
    CHECK(has(after, "\"pockets\":[true,true,true,true,false,false]"));
  }

  CHECK(iso_now().size() == 25 && iso_now()[10] == 'T' && iso_now()[22] == ':');
  CHECK(json_string("z-\"a\"\\") == "\"z-\\\"a\\\"\\\\\"");
  std::error_code ec;
  fs::remove_all(dir, ec);
  return finish("vision_test");
}
