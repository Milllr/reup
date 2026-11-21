// reup shelf node: the three lines that join reup_vision.hpp to the QNX AI workshop program (handtrack_node.cpp).
// This file needs the workshop's Hand type and OpenCV, so it builds on the Pi only. See ../README.md for where it goes.
#pragma once

#include <chrono>
#include <cstdlib>
#include <iostream>
#include <vector>

#include <opencv2/core.hpp>

#include "handtracking.hpp"
#include "reup_vision.hpp"

namespace reup {

inline Vision& vision() {
  static Vision v(
      [] {
        VisionConfig cfg;
        if (const char* dir = std::getenv("GUARD_DATA")) cfg.dir = dir;
        if (const char* th = std::getenv("REUP_THRESHOLD")) cfg.threshold = std::atof(th);
        return cfg;
      }(),
      std::cout);
  return v;
}

// Call once for every frame the hand model has looked at: the hands it found, and that frame.
inline void feed(const std::vector<Hand>& hands, const cv::Mat& bgr) {
  if (bgr.empty() || bgr.type() != CV_8UC3) return;
  std::vector<Pt> centres;
  for (const Hand& h : hands) {
    Pt c;
    for (const auto& p : h.pts) c.x += p.x / 21.0, c.y += p.y / 21.0;
    centres.push_back({c.x / bgr.cols, c.y / bgr.rows});
  }
  const auto t = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch()).count();
  vision().on_frame(centres.data(), static_cast<int>(centres.size()), Frame{bgr.data, bgr.cols, bgr.rows, static_cast<int>(bgr.step)}, t);
}

}  // namespace reup
