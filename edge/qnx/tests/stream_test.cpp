// Host test for the camera stream: a picture put in comes out over HTTP, once and as a stream, on the eye's own routes.
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <chrono>
#include <string>
#include <thread>

#include "check.hpp"
#include "reup_stream.hpp"

using namespace reup;

static int dial(int port) {
  const int fd = ::socket(AF_INET, SOCK_STREAM, 0);
  sockaddr_in addr{};
  addr.sin_family = AF_INET;
  addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  addr.sin_port = htons(static_cast<uint16_t>(port));
  timeval tv{3, 0};
  ::setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
  if (::connect(fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0) return -1;
  return fd;
}

static void ask(int fd, const std::string& path) {
  const std::string req = "GET " + path + " HTTP/1.1\r\nHost: test\r\n\r\n";
  ::send(fd, req.data(), req.size(), 0);
}

// Reads until the text holds want, or the other side stops.
static std::string read_until(int fd, const std::string& want, size_t at_least = 0) {
  std::string out;
  char buf[4096];
  while (out.find(want) == std::string::npos || out.size() < at_least) {
    const ssize_t got = ::recv(fd, buf, sizeof(buf), 0);
    if (got <= 0) break;
    out.append(buf, static_cast<size_t>(got));
  }
  return out;
}

static std::vector<unsigned char> picture(unsigned char fill, size_t n) {
  std::vector<unsigned char> v(n, fill);
  v[0] = 0xFF, v[1] = 0xD8, v[n - 2] = 0xFF, v[n - 1] = 0xD9;
  return v;
}

int main() {
  Stream stream;
  const int port = stream.start(0);
  CHECK(port > 0);
  CHECK(stream.port() == port);

  // Before the camera has given a picture, one picture asked for is a plain no, and health still answers.
  {
    const int fd = dial(port);
    CHECK(fd >= 0);
    ask(fd, "/health");
    const std::string got = read_until(fd, "watchers");
    CHECK(got.find("200 OK") != std::string::npos);
    CHECK(got.find("\"pictures\":0") != std::string::npos);
    CHECK(got.find("Access-Control-Allow-Origin: *") != std::string::npos);
    ::close(fd);
  }

  stream.put(picture(0x11, 5000));
  CHECK(stream.pictures() == 1);

  // The newest picture, once, whole.
  {
    const int fd = dial(port);
    ask(fd, "/frame.jpg");
    const std::string got = read_until(fd, "\r\n\r\n", 5000);
    const size_t body = got.find("\r\n\r\n");
    CHECK(got.find("Content-Type: image/jpeg") != std::string::npos);
    CHECK(got.find("Content-Length: 5000") != std::string::npos);
    CHECK(body != std::string::npos && got.size() - (body + 4) == 5000);
    CHECK(static_cast<unsigned char>(got[body + 4]) == 0xFF && static_cast<unsigned char>(got[body + 5]) == 0xD8);
    ::close(fd);
  }

  // The stream: the picture there is, then each new one as it comes, each with its length.
  {
    const int fd = dial(port);
    ask(fd, "/stream/board.mjpg");
    std::string got = read_until(fd, "--reupframe", 5100);
    CHECK(got.find("multipart/x-mixed-replace; boundary=reupframe") != std::string::npos);
    CHECK(got.find("Content-Length: 5000") != std::string::npos);
    for (int i = 0; i < 50 && stream.watchers() == 0; ++i) std::this_thread::sleep_for(std::chrono::milliseconds(10));
    CHECK(stream.watchers() == 1);
    stream.put(picture(0x22, 7000));
    got += read_until(fd, "Content-Length: 7000", got.size() + 7000);
    CHECK(got.find("Content-Length: 7000") != std::string::npos);
    // The same picture is never sent twice: two parts so far.
    size_t parts = 0;
    for (size_t at = got.find("--reupframe"); at != std::string::npos; at = got.find("--reupframe", at + 1)) ++parts;
    CHECK(parts == 2);
    ::close(fd);
    // The watcher left. The next picture finds that out and the count goes back down.
    stream.put(picture(0x33, 6000));
    stream.put(picture(0x44, 6000));
    for (int i = 0; i < 300 && stream.watchers() != 0; ++i) {
      std::this_thread::sleep_for(std::chrono::milliseconds(10));
      if (i % 20 == 0) stream.put(picture(0x55, 6000));
    }
    CHECK(stream.watchers() == 0);
  }

  // The board page asks for outlines beside the stream: it gets none, not an error. Anything else is a plain 404.
  {
    int fd = dial(port);
    ask(fd, "/outlines/board.json");
    std::string got = read_until(fd, "items");
    CHECK(got.find("200 OK") != std::string::npos && got.find("\"items\":[]") != std::string::npos);
    ::close(fd);
    fd = dial(port);
    ask(fd, "/teach");
    got = read_until(fd, "not_found");
    CHECK(got.find("404 Not Found") != std::string::npos);
    ::close(fd);
  }

  return finish("stream_test");
}
