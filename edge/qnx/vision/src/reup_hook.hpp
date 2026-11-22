// reup shelf node: the three lines that join reup_vision.hpp to the QNX AI workshop program (handtrack_node.cpp).
// This file needs the workshop's Hand type and OpenCV, so it builds on the Pi only. See ../README.md for where it goes.
#pragma once

#include <chrono>
#include <condition_variable>
#include <cstdlib>
#include <iostream>
#include <mutex>
#include <thread>
#include <vector>

#include <opencv2/core.hpp>
#include <opencv2/imgcodecs.hpp>

#include "handtracking.hpp"
#include "reup_stream.hpp"
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

// The camera's picture for the eye on the laptop and for the board page: reup_stream.hpp serves it, this makes the JPEGs.
// The camera thread only hands a frame over, at most REUP_STREAM_FPS times a second. A thread of its own does the
// encoding, so the hand model never waits for it. REUP_STREAM_PORT=0 turns it off.
class Sender {
 public:
  Sender() {
    int port = 8089, fps = 10;
    if (const char* v = std::getenv("REUP_STREAM_PORT")) port = std::atoi(v);
    if (const char* v = std::getenv("REUP_STREAM_FPS")) fps = std::atoi(v);
    if (const char* v = std::getenv("REUP_STREAM_QUALITY")) quality_ = std::atoi(v);
    every_ = std::chrono::milliseconds(1000 / (fps > 0 ? fps : 10));
    if (port <= 0) return;
    if (stream_.start(port) == 0) {
      // Not on stdout: that is where the guard reads its lines.
      std::cerr << "reup: could not listen on port " << port << ". The camera's picture is not served." << std::endl;
      return;
    }
    on_ = true;
    std::cerr << "reup: the camera's picture is served on port " << port << " (/stream/board.mjpg)." << std::endl;
    std::thread([this] { loop(); }).detach();
  }

  void offer(const cv::Mat& bgr) {
    if (!on_ || bgr.empty() || bgr.type() != CV_8UC3) return;
    const auto now = std::chrono::steady_clock::now();
    if (now - last_ < every_) return;
    last_ = now;
    {
      std::lock_guard<std::mutex> lk(mtx_);
      bgr.copyTo(next_);
      ready_ = true;
    }
    cv_.notify_one();
  }

 private:
  void loop() {
    cv::Mat frame;
    for (;;) {
      {
        std::unique_lock<std::mutex> lk(mtx_);
        cv_.wait(lk, [this] { return ready_; });
        cv::swap(frame, next_);
        ready_ = false;
      }
      std::vector<unsigned char> jpeg;
      if (cv::imencode(".jpg", frame, jpeg, {cv::IMWRITE_JPEG_QUALITY, quality_})) stream_.put(std::move(jpeg));
    }
  }

  Stream stream_;
  std::mutex mtx_;
  std::condition_variable cv_;
  cv::Mat next_;
  bool ready_ = false, on_ = false;
  int quality_ = 88;
  std::chrono::milliseconds every_{100};
  std::chrono::steady_clock::time_point last_{};
};

// Call for every frame the camera gives, at the camera's own size.
inline void offer(const cv::Mat& bgr) {
  static Sender sender;
  sender.offer(bgr);
}

}  // namespace reup
