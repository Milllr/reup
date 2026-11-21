"""A stand in for vision when there is no Pi: it prints the same JSON lines. Development only.

Usage, from edge/qnx: python3 supervisor.py --vision "python3 tools/fake_vision.py" --guard "python3 -m guard --hub http://localhost:3000"
It starts with 6 boxes of screws. To take two: write 2 into data/take.flag. To put some back: a negative number.
"""
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path

data = Path(os.environ.get("GUARD_DATA", Path(__file__).resolve().parent.parent / "data"))
zone, total = os.environ.get("FAKE_ZONE", "z-screws"), 12
# The count is kept in a file, so a restart sees the same board, as the real camera would.
memory = data / "fake_count"
count = int(memory.read_text()) if memory.exists() else int(os.environ.get("FAKE_COUNT", "6"))


def say(**event) -> None:
    print(json.dumps({**event, "ts": datetime.now().astimezone().isoformat(timespec="seconds")}), flush=True)


print('{"type":"hello","pockets":true,"model":false,"zones":1}', flush=True)
say(type="pockets", zone=zone, pockets=[i < count for i in range(total)])
while True:
    flag = data / "take.flag"
    if flag.exists():
        try:
            n = int(flag.read_text().strip() or "1")
        except ValueError:
            n = 1
        flag.unlink()
        say(type="reach", state="start", zone=zone)
        time.sleep(0.8)
        say(type="reach", state="end", zone=zone)
        time.sleep(0.5)
        count = max(0, min(total, count - n))
        memory.write_text(str(count))
        say(type="pockets", zone=zone, pockets=[i < count for i in range(total)])
    if (data / "die.flag").exists():
        (data / "die.flag").unlink()
        sys.exit(3)
    time.sleep(0.1)
