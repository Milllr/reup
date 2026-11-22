// reup shelf node: the camera's picture for the rest of reup, as MJPEG over HTTP.
//
// On the station as built there is one camera, and it is plugged into the Pi. The hand model on QNX looks at every
// frame, and the same frames go out here so the eye on the laptop can count the parts in them and the board page can
// show them. The routes are the ones the eye itself serves, on the same port, so a browser on the Pi finds the picture
// at the address the hub already gives it:
//   GET /stream/board.mjpg    the picture as it comes, one JPEG after another
//   GET /frame.jpg            the newest picture, once
//   GET /outlines/board.json  no outlines: the eye draws those, this only keeps the board page from asking in vain
//   GET /health               how many pictures went out and how many are watching
//
// Plain sockets and threads, nothing from QNX or OpenCV, so it builds and is tested on a laptop. The JPEG is made by
// the caller (reup_hook.hpp does it with OpenCV on the Pi).
#pragma once

#include <arpa/inet.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <csignal>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace reup {

class Stream {
 public:
  using Jpeg = std::shared_ptr<const std::vector<unsigned char>>;

  // Starts listening on every address. port 0 takes a free one (tests). Returns the port, or 0 when it cannot listen.
  int start(int port) {
    // A watcher that goes away mid picture must not take the whole program down with it.
    std::signal(SIGPIPE, SIG_IGN);
    const int fd = ::socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) return 0;
    int yes = 1;
    ::setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));
    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_ANY);
    addr.sin_port = htons(static_cast<uint16_t>(port));
    if (::bind(fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0 || ::listen(fd, 8) != 0) {
      ::close(fd);
      return 0;
    }
    socklen_t len = sizeof(addr);
    ::getsockname(fd, reinterpret_cast<sockaddr*>(&addr), &len);
    port_ = ntohs(addr.sin_port);
    std::thread([this, fd] { accept_loop(fd); }).detach();
    return port_;
  }

  // The newest picture. Cheap: it is only handed over, whoever is watching sends it.
  void put(std::vector<unsigned char>&& jpeg) {
    {
      std::lock_guard<std::mutex> lk(mtx_);
      latest_ = std::make_shared<const std::vector<unsigned char>>(std::move(jpeg));
      ++seq_;
    }
    cv_.notify_all();
  }

  int port() const { return port_; }
  int watchers() const { return watchers_.load(); }
  long pictures() const {
    std::lock_guard<std::mutex> lk(mtx_);
    return seq_;
  }

 private:
  static bool send_all(int fd, const void* data, size_t n) {
    const char* p = static_cast<const char*>(data);
    while (n > 0) {
#ifdef MSG_NOSIGNAL
      const ssize_t sent = ::send(fd, p, n, MSG_NOSIGNAL);
#else
      const ssize_t sent = ::send(fd, p, n, 0);
#endif
      if (sent <= 0) return false;
      p += sent;
      n -= static_cast<size_t>(sent);
    }
    return true;
  }
  static bool send_text(int fd, const std::string& s) { return send_all(fd, s.data(), s.size()); }

  void accept_loop(int fd) {
    for (;;) {
      const int client = ::accept(fd, nullptr, nullptr);
      if (client < 0) {
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
        continue;
      }
      std::thread([this, client] {
        serve(client);
        ::close(client);
      }).detach();
    }
  }

  // Waits for a picture newer than seen, for at most wait_ms. Returns null when none came.
  Jpeg next(long& seen, int wait_ms) {
    std::unique_lock<std::mutex> lk(mtx_);
    cv_.wait_for(lk, std::chrono::milliseconds(wait_ms), [&] { return seq_ != seen && latest_; });
    if (seq_ == seen || !latest_) return nullptr;
    seen = seq_;
    return latest_;
  }

  void serve(int fd) {
    // A watcher that stops reading is dropped after 3 seconds, so it never holds a thread for good.
    timeval tv{3, 0};
    ::setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
    ::setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    int yes = 1;
    ::setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &yes, sizeof(yes));

    // The request: only its first line matters, read up to the blank line.
    std::string req;
    char buf[1024];
    while (req.find("\r\n\r\n") == std::string::npos && req.size() < 8192) {
      const ssize_t got = ::recv(fd, buf, sizeof(buf), 0);
      if (got <= 0) return;
      req.append(buf, static_cast<size_t>(got));
    }
    const std::string line = req.substr(0, req.find("\r\n"));
    const size_t a = line.find(' ');
    const size_t b = line.find(' ', a == std::string::npos ? 0 : a + 1);
    const std::string path = a == std::string::npos || b == std::string::npos ? "" : line.substr(a + 1, b - a - 1);
    const std::string cors = "Access-Control-Allow-Origin: *\r\nCache-Control: no-store\r\nConnection: close\r\n";

    if (path.rfind("/stream/", 0) == 0) {
      if (!send_text(fd, "HTTP/1.1 200 OK\r\nContent-Type: multipart/x-mixed-replace; boundary=reupframe\r\n" + cors + "\r\n")) return;
      ++watchers_;
      long seen = -1;
      for (;;) {
        const Jpeg jpeg = next(seen, 2000);
        if (!jpeg) {
          // No new picture in 2 seconds: say nothing, but find out whether the watcher is still there.
          if (!send_text(fd, "")) break;
          char probe;
          const ssize_t got = ::recv(fd, &probe, 1, MSG_PEEK | MSG_DONTWAIT);
          if (got == 0) break;
          continue;
        }
        char head[128];
        const int n = std::snprintf(head, sizeof(head), "--reupframe\r\nContent-Type: image/jpeg\r\nContent-Length: %zu\r\n\r\n", jpeg->size());
        if (!send_all(fd, head, static_cast<size_t>(n)) || !send_all(fd, jpeg->data(), jpeg->size()) || !send_text(fd, "\r\n")) break;
      }
      --watchers_;
      return;
    }
    if (path.rfind("/frame.jpg", 0) == 0) {
      long seen = -1;
      const Jpeg jpeg = next(seen, 2000);
      if (!jpeg) {
        send_text(fd, "HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\n" + cors + "\r\n{\"ok\":false,\"message\":\"No picture from the camera yet.\"}");
        return;
      }
      if (send_text(fd, "HTTP/1.1 200 OK\r\nContent-Type: image/jpeg\r\nContent-Length: " + std::to_string(jpeg->size()) + "\r\n" + cors + "\r\n")) send_all(fd, jpeg->data(), jpeg->size());
      return;
    }
    std::string body;
    std::string status = "200 OK";
    if (path.rfind("/outlines/", 0) == 0) {
      body = "{\"ts\":\"\",\"items\":[]}";
    } else if (path == "/" || path.rfind("/health", 0) == 0) {
      body = "{\"ok\":true,\"node\":true,\"pictures\":" + std::to_string(pictures()) + ",\"watchers\":" + std::to_string(watchers()) + "}";
    } else {
      status = "404 Not Found";
      body = "{\"ok\":false,\"code\":\"not_found\",\"message\":\"The shelf node serves the camera's picture only.\"}";
    }
    send_text(fd, "HTTP/1.1 " + status + "\r\nContent-Type: application/json\r\nContent-Length: " + std::to_string(body.size()) + "\r\n" + cors + "\r\n" + body);
  }

  mutable std::mutex mtx_;
  std::condition_variable cv_;
  Jpeg latest_;
  long seq_ = 0;
  int port_ = 0;
  std::atomic<int> watchers_{0};
};

}  // namespace reup
