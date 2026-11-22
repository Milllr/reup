// A camera that is plugged into another machine and reaches the Pi as MJPEG over HTTP.
//
// On the station the one camera is plugged into the laptop. The eye there counts the parts and serves the same
// pictures on port 8089 (/stream/board.mjpg). The Pi reads them here, over the cable, and QNX's hand model looks at
// them. The Pi is beside the counting, not in its way: unplug the Pi and the board is still counted.
//
// Why not plug the camera into the Pi: its USB link on QNX carries about 8 MB of uncompressed picture a second, which
// is 5.9 pictures a second at 720p. Over the cable the same camera arrives at the rate the laptop sends it.
//
// Header only, POSIX sockets, no OpenCV: the pictures come out as JPEG bytes. Host tested in tests/netcam_test.cpp.
#pragma once

#include <arpa/inet.h>
#include <netdb.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>

#include <algorithm>
#include <atomic>
#include <cctype>
#include <chrono>
#include <cstdlib>
#include <cstring>
#include <functional>
#include <string>
#include <thread>
#include <vector>

namespace reup {

struct Url {
  std::string host;
  int port = 80;
  std::string path = "/";
  bool ok = false;
};

// http://host:port/path and nothing else.
inline Url parse_url(const std::string& url) {
  Url u;
  const std::string scheme = "http://";
  if (url.compare(0, scheme.size(), scheme) != 0) return u;
  const std::string rest = url.substr(scheme.size());
  const size_t slash = rest.find('/');
  const std::string hostport = slash == std::string::npos ? rest : rest.substr(0, slash);
  if (slash != std::string::npos) u.path = rest.substr(slash);
  const size_t colon = hostport.rfind(':');
  if (colon == std::string::npos) {
    u.host = hostport;
  } else {
    u.host = hostport.substr(0, colon);
    u.port = std::atoi(hostport.substr(colon + 1).c_str());
  }
  u.ok = !u.host.empty() && u.port > 0 && u.port < 65536;
  return u;
}

// One connection, read through a buffer: lines for the headers, exact byte counts for the pictures.
class NetConn {
 public:
  ~NetConn() { close(); }

  bool open(const Url& u, int timeout_s) {
    close();
    addrinfo hints{};
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_STREAM;
    addrinfo* found = nullptr;
    if (::getaddrinfo(u.host.c_str(), std::to_string(u.port).c_str(), &hints, &found) != 0 || !found) return false;
    const int fd = ::socket(found->ai_family, found->ai_socktype, found->ai_protocol);
    if (fd < 0) {
      ::freeaddrinfo(found);
      return false;
    }
    timeval tv{timeout_s, 0};
    ::setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    ::setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
    const bool up = ::connect(fd, found->ai_addr, found->ai_addrlen) == 0;
    ::freeaddrinfo(found);
    if (!up) {
      ::close(fd);
      return false;
    }
    fd_.store(fd);
    buf_.clear();
    at_ = 0;
    const std::string req = "GET " + u.path + " HTTP/1.1\r\nHost: " + u.host + "\r\nAccept: multipart/x-mixed-replace\r\nConnection: close\r\n\r\n";
    if (::send(fd, req.data(), req.size(), 0) != static_cast<ssize_t>(req.size())) return false;
    std::string status;
    if (!line(status) || status.find(" 200") == std::string::npos) return false;
    return skip_headers(nullptr);
  }

  // The next picture of the stream. False when the stream ended, went quiet, or sent something that is no part.
  bool picture(std::vector<unsigned char>& jpeg, size_t max_bytes = 8000000) {
    std::string text;
    for (;;) {
      if (!line(text)) return false;
      if (text.compare(0, 2, "--") == 0) break;
    }
    long length = 0;
    if (!skip_headers(&length) || length <= 0 || static_cast<size_t>(length) > max_bytes) return false;
    jpeg.resize(static_cast<size_t>(length));
    size_t have = 0;
    while (have < jpeg.size()) {
      if (at_ < buf_.size()) {
        const size_t take = std::min(buf_.size() - at_, jpeg.size() - have);
        std::memcpy(jpeg.data() + have, buf_.data() + at_, take);
        at_ += take;
        have += take;
        continue;
      }
      const int fd = fd_.load();
      if (fd < 0) return false;
      const ssize_t got = ::recv(fd, jpeg.data() + have, jpeg.size() - have, 0);
      if (got <= 0) return false;
      have += static_cast<size_t>(got);
    }
    return true;
  }

  // Safe from another thread: a read that is waiting comes back at once.
  void hang_up() {
    const int fd = fd_.load();
    if (fd >= 0) ::shutdown(fd, SHUT_RDWR);
  }

  void close() {
    const int fd = fd_.exchange(-1);
    if (fd >= 0) ::close(fd);
  }

 private:
  bool fill() {
    if (at_ > 0) {
      buf_.erase(0, at_);
      at_ = 0;
    }
    const int fd = fd_.load();
    if (fd < 0) return false;
    char chunk[8192];
    const ssize_t got = ::recv(fd, chunk, sizeof(chunk), 0);
    if (got <= 0) return false;
    buf_.append(chunk, static_cast<size_t>(got));
    return true;
  }

  bool line(std::string& out) {
    for (;;) {
      const size_t end = buf_.find('\n', at_);
      if (end != std::string::npos) {
        out.assign(buf_, at_, end - at_);
        at_ = end + 1;
        while (!out.empty() && (out.back() == '\r' || out.back() == ' ')) out.pop_back();
        return true;
      }
      if (buf_.size() - at_ > 65536 || !fill()) return false;
    }
  }

  // Header lines up to the blank one. length gets Content-Length when it is there.
  bool skip_headers(long* length) {
    std::string text;
    for (;;) {
      if (!line(text)) return false;
      if (text.empty()) return true;
      if (!length) continue;
      std::string lower = text;
      for (char& c : lower) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
      const std::string name = "content-length:";
      if (lower.compare(0, name.size(), name) == 0) *length = std::atol(text.c_str() + name.size());
    }
  }

  std::atomic<int> fd_{-1};
  std::string buf_;
  size_t at_ = 0;
};

// Reads one MJPEG stream for as long as it is asked to, and connects again whenever the stream ends or goes quiet.
class MjpegReader {
 public:
  using OnJpeg = std::function<void(const std::vector<unsigned char>&)>;

  ~MjpegReader() { stop(); }

  // One picture, to learn that the stream is there and what size it is. Empty when none came.
  static std::vector<unsigned char> first(const std::string& url, int timeout_s = 3) {
    std::vector<unsigned char> jpeg;
    const Url u = parse_url(url);
    NetConn conn;
    if (!u.ok || !conn.open(u, timeout_s) || !conn.picture(jpeg)) jpeg.clear();
    return jpeg;
  }

  bool start(const std::string& url, OnJpeg on_jpeg, int timeout_s = 3) {
    const Url u = parse_url(url);
    if (!u.ok || running_.load()) return false;
    running_.store(true);
    thread_ = std::thread([this, u, on_jpeg, timeout_s] {
      std::vector<unsigned char> jpeg;
      while (running_.load()) {
        if (conn_.open(u, timeout_s)) {
          connects_.fetch_add(1);
          while (running_.load() && conn_.picture(jpeg)) {
            pictures_.fetch_add(1);
            on_jpeg(jpeg);
          }
        }
        conn_.close();
        // The other machine is restarting its program, or the cable is out. Ask again shortly, for as long as it takes.
        for (int i = 0; i < 5 && running_.load(); ++i) std::this_thread::sleep_for(std::chrono::milliseconds(100));
      }
    });
    return true;
  }

  void stop() {
    if (!running_.exchange(false)) return;
    conn_.hang_up();
    if (thread_.joinable()) thread_.join();
  }

  long pictures() const { return pictures_.load(); }
  long connects() const { return connects_.load(); }

 private:
  NetConn conn_;
  std::thread thread_;
  std::atomic<bool> running_{false};
  std::atomic<long> pictures_{0};
  std::atomic<long> connects_{0};
};

}  // namespace reup
