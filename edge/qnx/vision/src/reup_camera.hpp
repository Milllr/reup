// The hand tracker's camera: the Pi's own (the workshop's RpiCam), or one that arrives over the network.
//
// REUP_CAMERA_URL set, for example http://169.254.138.173:8089/stream/board.mjpg: the pictures are read from there
// (reup_netcam.hpp). Not set: the camera on the Pi's own USB, exactly as the workshop program opens it.
// The same four calls as RpiCam, so handtrack_node.cpp changes by one word. Built on the Pi only: it needs the QNX
// camera headers and OpenCV.
#pragma once

#include <cerrno>
#include <cstdlib>
#include <iostream>
#include <string>
#include <utility>
#include <vector>

#include <opencv2/imgcodecs.hpp>

#include "reup_netcam.hpp"
#include "rpi_cam.hpp"

namespace reup {

class Camera {
 public:
  explicit Camera(camera_unit_t unit) : usb_(unit) {
    if (const char* url = std::getenv("REUP_CAMERA_URL")) url_ = url;
  }

  int init() {
    if (url_.empty()) return usb_.init();
    // The other machine may still be starting its program. Ask for a minute, then let the supervisor start us again.
    for (int i = 0; i < 20; ++i) {
      const std::vector<unsigned char> jpeg = MjpegReader::first(url_, 3);
      const cv::Mat first = jpeg.empty() ? cv::Mat() : cv::imdecode(jpeg, cv::IMREAD_COLOR);
      if (!first.empty()) {
        width_ = first.cols;
        height_ = first.rows;
        // Not on stdout: that is where the guard reads its lines.
        std::cerr << "reup: the camera is " << url_ << ", " << width_ << "x" << height_ << "." << std::endl;
        return 0;
      }
      if (i == 0) std::cerr << "reup: no picture yet from " << url_ << ". Asking again." << std::endl;
    }
    std::cerr << "reup: no picture from " << url_ << " in a minute." << std::endl;
    return ETIMEDOUT;
  }

  int start(RpiCam::FrameCb callback) {
    if (url_.empty()) return usb_.start(std::move(callback));
    const bool ok = reader_.start(url_, [callback](const std::vector<unsigned char>& jpeg) {
      const cv::Mat bgr = cv::imdecode(jpeg, cv::IMREAD_COLOR);
      if (!bgr.empty()) callback(bgr);
    });
    return ok ? 0 : EINVAL;
  }

  int stop() {
    if (url_.empty()) return usb_.stop();
    reader_.stop();
    return 0;
  }

  std::pair<int, int> get_frame_size() const {
    return url_.empty() ? usb_.get_frame_size() : std::make_pair(width_, height_);
  }

 private:
  RpiCam usb_;
  MjpegReader reader_;
  std::string url_;
  int width_ = 0, height_ = 0;
};

}  // namespace reup
