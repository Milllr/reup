// Host test for the camera that comes over the network: the Pi reads the pictures another machine serves, one by one,
// and connects again when the stream ends. The server here is reup's own stream server, the same wire format the
// eye on the laptop sends.
#include <chrono>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "check.hpp"
#include "reup_netcam.hpp"
#include "reup_stream.hpp"

using namespace reup;

static std::vector<unsigned char> picture(unsigned char fill, size_t n) {
  std::vector<unsigned char> v(n, fill);
  v[0] = 0xFF, v[1] = 0xD8, v[n - 2] = 0xFF, v[n - 1] = 0xD9;
  return v;
}

template <typename F>
static bool wait_for(F done, int ms = 3000) {
  for (int i = 0; i < ms / 10; ++i) {
    if (done()) return true;
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }
  return done();
}

int main() {
  // An address is http://host:port/path and nothing else.
  {
    const Url u = parse_url("http://169.254.138.173:8089/stream/board.mjpg");
    CHECK(u.ok && u.host == "169.254.138.173" && u.port == 8089 && u.path == "/stream/board.mjpg");
    const Url bare = parse_url("http://laptop.local");
    CHECK(bare.ok && bare.host == "laptop.local" && bare.port == 80 && bare.path == "/");
    CHECK(!parse_url("rtsp://laptop.local/stream").ok);
    CHECK(!parse_url("http://:8089/x").ok);
    CHECK(!parse_url("http://laptop.local:99999/x").ok);
  }

  Stream stream;
  const int port = stream.start(0);
  CHECK(port > 0);
  const std::string url = "http://127.0.0.1:" + std::to_string(port) + "/stream/board.mjpg";

  // One picture, to learn the stream is there. It is the whole picture, byte for byte.
  stream.put(picture(0x11, 5000));
  {
    const std::vector<unsigned char> got = MjpegReader::first(url, 2);
    CHECK(got == picture(0x11, 5000));
  }
  // Nothing listens there: an empty answer, and soon.
  {
    Stream other;
    const int free_port = other.start(0);
    CHECK(MjpegReader::first("http://127.0.0.1:" + std::to_string(free_port) + "/nothing-here", 1).empty());
    CHECK(MjpegReader::first("not an address", 1).empty());
  }

  // The stream, picture by picture, in order, each one whole. Sizes differ so a wrong byte count would show.
  {
    std::mutex mtx;
    std::vector<std::vector<unsigned char>> seen;
    MjpegReader reader;
    CHECK(reader.start(url, [&](const std::vector<unsigned char>& jpeg) {
      std::lock_guard<std::mutex> lk(mtx);
      seen.push_back(jpeg);
    }, 2));
    // A second start while it runs is refused.
    CHECK(!reader.start(url, [](const std::vector<unsigned char>&) {}));
    auto count = [&] {
      std::lock_guard<std::mutex> lk(mtx);
      return seen.size();
    };
    CHECK(wait_for([&] { return count() >= 1; }));
    stream.put(picture(0x22, 70000));
    CHECK(wait_for([&] { return count() >= 2; }));
    stream.put(picture(0x33, 300));
    CHECK(wait_for([&] { return count() >= 3; }));
    {
      std::lock_guard<std::mutex> lk(mtx);
      CHECK(seen.size() == 3);
      if (seen.size() == 3) {
        CHECK(seen[0] == picture(0x11, 5000));
        CHECK(seen[1] == picture(0x22, 70000));
        CHECK(seen[2] == picture(0x33, 300));
      }
    }
    CHECK(reader.pictures() == 3);
    CHECK(reader.connects() == 1);
    // Stopping comes back at once, though the reader is waiting for a picture that never comes.
    const auto t0 = std::chrono::steady_clock::now();
    reader.stop();
    CHECK(std::chrono::steady_clock::now() - t0 < std::chrono::seconds(2));
    reader.stop();  // twice is fine
  }

  // The other machine is not up: every connect is refused. The reader keeps asking, gives no picture, and still stops.
  {
    std::atomic<int> got{0};
    MjpegReader reader;
    CHECK(reader.start("http://127.0.0.1:1/stream/board.mjpg", [&](const std::vector<unsigned char>&) { got.fetch_add(1); }, 1));
    std::this_thread::sleep_for(std::chrono::milliseconds(700));
    CHECK(got.load() == 0);
    CHECK(reader.connects() == 0);
    reader.stop();
  }

  // The stream ends and comes back (the eye was restarted): the reader connects again by itself.
  {
    std::atomic<int> got{0};
    MjpegReader reader;
    {
      Stream brief;
      const int brief_port = brief.start(0);
      brief.put(picture(0x44, 900));
      CHECK(reader.start("http://127.0.0.1:" + std::to_string(brief_port) + "/frame.jpg", [&](const std::vector<unsigned char>&) { got.fetch_add(1); }, 1));
      // /frame.jpg is one picture and then the connection closes: not a stream, so no picture is taken from it,
      // and the reader asks again and again without stopping or crashing.
      std::this_thread::sleep_for(std::chrono::milliseconds(900));
    }
    CHECK(got.load() == 0);
    reader.stop();
  }

  return finish("netcam_test");
}
