// Host tests for reach timing.
#include "check.hpp"

using namespace reup;
using E = ReachTracker::Event;

int main() {
  ReachTracker r(400, 2);
  // One frame with a hand is not a reach.
  CHECK(r.update(true, "z-screws", 0) == E::None);
  CHECK(r.update(false, "", 33) == E::None);
  CHECK(!r.active());
  // Two in a row is.
  CHECK(r.update(true, "", 66) == E::None);
  CHECK(r.update(true, "z-screws", 100) == E::Start);
  CHECK(r.active() && r.zone() == "z-screws");
  // The hand is lost for one frame: the reach goes on.
  CHECK(r.update(false, "", 133) == E::None);
  CHECK(r.update(true, "z-brackets", 166) == E::None);
  CHECK(r.active() && r.zone() == "z-brackets");
  // The hand leaves. Nothing for 399 ms, then the reach ends.
  CHECK(r.update(false, "", 200) == E::None);
  CHECK(r.update(false, "", 565) == E::None);
  CHECK(r.active());
  CHECK(r.update(false, "", 566) == E::End);
  CHECK(!r.active() && r.ended_at() == 566 && r.zone() == "z-brackets");
  CHECK(r.update(false, "", 600) == E::None);
  // The next reach, over no zone, does not carry the old zone.
  r.clear_zone();
  CHECK(r.update(true, "", 1000) == E::None);
  CHECK(r.update(true, "", 1033) == E::Start);
  CHECK(r.zone().empty());
  // A hand that stays is one reach, however long.
  for (int t = 1066; t < 6000; t += 33) CHECK(r.update(true, "", t) == E::None);
  CHECK(r.update(false, "", 6400) == E::End);
  return finish("reach_test");
}
