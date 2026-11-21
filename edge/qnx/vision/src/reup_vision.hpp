// reup shelf node: the vision side. Feed it every frame and the hands found in it; it prints one JSON line an event.
//
//   {"type":"hello","pockets":true,"model":false,"zones":2}
//   {"type":"reach","state":"start","zone":"z-screws","ts":"2026-11-21T09:14:00-05:00"}
//   {"type":"reach","state":"end","zone":"z-screws","ts":"2026-11-21T09:14:02-05:00"}
//   {"type":"pockets","zone":"z-screws","pockets":[true,true,false],"ts":"2026-11-21T09:14:03-05:00"}
//
// It reads zones.txt (written by the guard) from its data folder, and two flag files a person makes with the scripts:
// capture.flag saves the empty board, snapshot.flag writes snapshot.ppm for finding the zone corners.
// C++17, standard library only. The QNX hook that feeds it from the workshop program is reup_hook.hpp.
#pragma once

#include <chrono>
#include <cstdio>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <map>
#include <ostream>
#include <string>
#include <system_error>
#include <vector>

#include "reup_math.hpp"

namespace reup {

struct VisionConfig {
  std::string dir = "data";
  double threshold = 18.0;  // a pocket is full over this mean difference, 0 to 255
  double inset = 0.18;
  int samples = 10;
  int still_ms = 500;      // stillness needed before pockets are read
  int reach_end_ms = 400;  // no hand for this long ends a reach
  double motion_pixel = 14.0;
  double motion_limit = 0.01;
  Quad board = FULL_FRAME;  // the board in this camera's picture
};

inline std::string iso_now() {
  const std::time_t t = std::chrono::system_clock::to_time_t(std::chrono::system_clock::now());
  std::tm local{};
  localtime_r(&t, &local);
  char buf[40];
  std::strftime(buf, sizeof buf, "%Y-%m-%dT%H:%M:%S%z", &local);
  std::string s(buf);
  if (s.size() >= 5 && (s[s.size() - 5] == '+' || s[s.size() - 5] == '-')) s.insert(s.size() - 2, ":");  // +0500 to +05:00
  return s;
}

inline std::string json_string(const std::string& s) {
  std::string out = "\"";
  for (char ch : s) {
    if (ch == '"' || ch == '\\') out += '\\';
    if (static_cast<unsigned char>(ch) >= 0x20) out += ch;
  }
  return out + "\"";
}

class Vision {
 public:
  Vision(VisionConfig cfg, std::ostream& out, std::string (*clock)() = iso_now) : cfg_(std::move(cfg)), out_(out), clock_(clock), reach_(cfg_.reach_end_ms) {
    load_reference();
  }

  // hands: the centre of every hand found in this frame, normalized. t_ms: a steady clock in milliseconds.
  void on_frame(const Pt* hands, int n_hands, const Frame& frame, int64_t t_ms) {
    if (!frame.ok()) return;
    housekeeping(frame, t_ms);

    bool hand = false;
    std::string zone;
    for (int i = 0; i < n_hands; ++i) {
      if (!point_in_quad(hands[i], cfg_.board)) continue;
      hand = true;
      for (const Zone& z : zones_)
        if (zone.empty() && point_in_quad(hands[i], z.quad)) zone = z.id;
    }
    switch (reach_.update(hand, zone, t_ms)) {
      case ReachTracker::Event::Start:
        emit_reach("start");
        break;
      case ReachTracker::Event::End:
        emit_reach("end");
        reach_.clear_zone();
        dirty_ = true;
        break;
      default:
        break;
    }

    const std::vector<Colour> now = sample_all(frame, motion_pts_);
    if (motion(now, before_, cfg_.motion_pixel) > cfg_.motion_limit) last_motion_ = t_ms;
    before_ = now;

    const bool still = !reach_.active() && t_ms - std::max(last_motion_, reach_.ended_at()) >= cfg_.still_ms;
    if (dirty_ && still && pockets_ready()) {
      read_pockets(frame);
      dirty_ = false;
    }
  }

  bool pockets_ready() const {
    if (ref_.empty()) return false;
    for (const Zone& z : zones_)
      if (z.pockets() > 0) return true;
    return false;
  }
  const std::vector<Zone>& zones() const { return zones_; }

 private:
  // ---------- files ----------

  void housekeeping(const Frame& frame, int64_t t_ms) {
    namespace fs = std::filesystem;
    if (first_ || t_ms - checked_ >= 1000) {
      checked_ = t_ms;
      std::error_code ec;
      const fs::path zones = fs::path(cfg_.dir) / "zones.txt";
      const auto stamp = fs::exists(zones, ec) ? fs::last_write_time(zones, ec).time_since_epoch().count() : 0;
      if (first_ || stamp != zones_stamp_) {
        zones_stamp_ = stamp;
        std::ifstream in(zones);
        zones_ = parse_zones(in);
        relayout(frame);
        announce();
      }
      const fs::path capture = fs::path(cfg_.dir) / "capture.flag";
      if (fs::exists(capture, ec)) {
        fs::remove(capture, ec);
        save_reference(frame);
        relayout(frame);
        announce();
        out_ << "{\"type\":\"reference\",\"ok\":true,\"ts\":" << json_string(clock_()) << "}" << std::endl;
      }
      const fs::path snap = fs::path(cfg_.dir) / "snapshot.flag";
      if (fs::exists(snap, ec)) {
        fs::remove(snap, ec);
        write_ppm(frame, (fs::path(cfg_.dir) / "snapshot.ppm").string());
      }
    }
    if (first_ || frame.w != layout_w_ || frame.h != layout_h_) relayout(frame);
    first_ = false;
  }

  std::string ref_path() const { return (std::filesystem::path(cfg_.dir) / "reference.bgr").string(); }

  void save_reference(const Frame& f) {
    ref_w_ = f.w, ref_h_ = f.h;
    ref_.resize(static_cast<size_t>(f.w) * f.h * 3);
    for (int y = 0; y < f.h; ++y) std::copy(f.data + static_cast<ptrdiff_t>(y) * f.stride, f.data + static_cast<ptrdiff_t>(y) * f.stride + f.w * 3, ref_.begin() + static_cast<ptrdiff_t>(y) * f.w * 3);
    std::error_code ec;
    std::filesystem::create_directories(cfg_.dir, ec);
    std::ofstream out(ref_path(), std::ios::binary);
    out << "REUPREF1 " << f.w << " " << f.h << "\n";
    out.write(reinterpret_cast<const char*>(ref_.data()), static_cast<std::streamsize>(ref_.size()));
  }

  void load_reference() {
    std::ifstream in(ref_path(), std::ios::binary);
    std::string magic;
    int w = 0, h = 0;
    if (!(in >> magic >> w >> h) || magic != "REUPREF1" || w < 3 || h < 3 || w > 8192 || h > 8192) return;
    in.get();
    std::vector<uint8_t> buf(static_cast<size_t>(w) * h * 3);
    in.read(reinterpret_cast<char*>(buf.data()), static_cast<std::streamsize>(buf.size()));
    if (static_cast<size_t>(in.gcount()) != buf.size()) return;
    ref_ = std::move(buf), ref_w_ = w, ref_h_ = h;
  }

  static void write_ppm(const Frame& f, const std::string& path) {
    std::ofstream out(path, std::ios::binary);
    out << "P6\n" << f.w << " " << f.h << "\n255\n";
    for (int y = 0; y < f.h; ++y)
      for (int x = 0; x < f.w; ++x) {
        const uint8_t* p = f.data + static_cast<ptrdiff_t>(y) * f.stride + x * 3;
        const char rgb[3] = {static_cast<char>(p[2]), static_cast<char>(p[1]), static_cast<char>(p[0])};
        out.write(rgb, 3);
      }
  }

  // ---------- where to look ----------

  void relayout(const Frame& frame) {
    layout_w_ = frame.w, layout_h_ = frame.h;
    motion_pts_ = grid_points(cfg_.board, 24);
    before_.clear();
    border_pts_ = border_points(cfg_.board, zones_);
    cells_.clear(), ref_cells_.clear(), ref_border_.clear();
    state_.clear();
    dirty_ = true;
    if (ref_.empty() || ref_w_ != frame.w || ref_h_ != frame.h) {
      if (!ref_.empty()) ref_.clear();  // the camera changed size: the old empty board no longer lines up
      return;
    }
    const Frame ref{ref_.data(), ref_w_, ref_h_, ref_w_ * 3};
    ref_border_ = sample_all(ref, border_pts_);
    for (const Zone& z : zones_) {
      Homography h;
      if (z.pockets() == 0 || !unit_to_quad(z.quad, h)) continue;
      for (int i = 0; i < z.pockets(); ++i) {
        cells_[z.id].push_back(cell_points(h, z.rows, z.cols, i, cfg_.samples, cfg_.inset));
        ref_cells_[z.id].push_back(sample_all(ref, cells_[z.id].back()));
      }
    }
  }

  void announce() {
    const bool ready = pockets_ready();
    out_ << "{\"type\":\"hello\",\"pockets\":" << (ready ? "true" : "false") << ",\"model\":false,\"zones\":" << zones_.size() << "}" << std::endl;
  }

  // ---------- events ----------

  void emit_reach(const char* state) {
    out_ << "{\"type\":\"reach\",\"state\":\"" << state << "\",\"zone\":";
    if (reach_.zone().empty())
      out_ << "null";
    else
      out_ << json_string(reach_.zone());
    out_ << ",\"ts\":" << json_string(clock_()) << "}" << std::endl;
  }

  void read_pockets(const Frame& frame) {
    const double g = border_pts_.empty() ? 1.0 : gain(sample_all(frame, border_pts_), ref_border_);
    for (const Zone& z : zones_) {
      const auto cells = cells_.find(z.id);
      if (cells == cells_.end()) continue;
      const std::vector<bool>* before = state_.count(z.id) ? &state_[z.id] : nullptr;
      std::vector<bool> full;
      for (size_t i = 0; i < cells->second.size(); ++i) {
        const double lvl = level(sample_all(frame, cells->second[i]), ref_cells_[z.id][i], g);
        full.push_back(is_full(lvl, cfg_.threshold, before != nullptr && (*before)[i]));
      }
      if (before != nullptr && *before == full) continue;
      state_[z.id] = full;
      out_ << "{\"type\":\"pockets\",\"zone\":" << json_string(z.id) << ",\"pockets\":[";
      for (size_t i = 0; i < full.size(); ++i) out_ << (i ? "," : "") << (full[i] ? "true" : "false");
      out_ << "],\"ts\":" << json_string(clock_()) << "}" << std::endl;
    }
  }

  VisionConfig cfg_;
  std::ostream& out_;
  std::string (*clock_)();
  ReachTracker reach_;
  std::vector<Zone> zones_;
  std::vector<uint8_t> ref_;
  int ref_w_ = 0, ref_h_ = 0, layout_w_ = 0, layout_h_ = 0;
  std::vector<Pt> motion_pts_, border_pts_;
  std::vector<Colour> before_, ref_border_;
  std::map<std::string, std::vector<std::vector<Pt>>> cells_;
  std::map<std::string, std::vector<std::vector<Colour>>> ref_cells_;
  std::map<std::string, std::vector<bool>> state_;
  bool first_ = true, dirty_ = true;
  int64_t checked_ = 0, last_motion_ = -1000000;
  long long zones_stamp_ = -1;
};

}  // namespace reup
