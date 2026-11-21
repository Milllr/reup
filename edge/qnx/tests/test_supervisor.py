"""The supervisor, with real child processes."""
import json
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest

from supervisor import Supervisor

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="The supervisor runs on the Pi. Its tests need POSIX pipes and signals.")

HERE = Path(__file__).resolve().parent.parent
PY = sys.executable


def wait_for(check, seconds=5.0):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if check():
            return True
        time.sleep(0.05)
    return False


def test_it_restarts_a_child_that_exits_within_a_second_counts_it_and_loses_no_line(tmp_path):
    out = tmp_path / "seen.txt"
    counter = tmp_path / "n.txt"
    # Vision: prints one line, then dies. Each life prints the next number.
    vision = [PY, "-c", f"import pathlib,sys,time; p=pathlib.Path(r'{counter}'); n=int(p.read_text()) if p.exists() else 0; p.write_text(str(n+1)); print('line', n, flush=True); time.sleep(0.3)"]
    # Guard: copies what it reads to a file.
    guard = [PY, "-c", f"import sys\nfor line in sys.stdin:\n    open(r'{out}','a').write(line)"]
    sup = Supervisor(vision, guard, tmp_path, log=lambda _t: None)
    try:
        started = time.monotonic()
        while time.monotonic() - started < 4 and sup.restarts["vision"] < 3:
            sup.step()
            time.sleep(0.05)
        assert sup.restarts["vision"] >= 3
        assert json.loads((tmp_path / "restarts.json").read_text())["vision"] == sup.restarts["vision"]
        assert sup.restarts["guard"] == 0
        # Kill the guard too: it comes back and reads on from the same pipe.
        sup.children["guard"].kill()
        assert wait_for(lambda: (sup.step(), sup.restarts["guard"] == 1)[1])
        assert wait_for(lambda: (sup.step(), out.exists() and len(out.read_text().splitlines()) >= 5)[1])
        lines = out.read_text().splitlines()
        assert lines == [f"line {i}" for i in range(len(lines))]  # none lost, none doubled, in order
    finally:
        sup.stop()


def test_a_dead_child_is_back_within_a_second(tmp_path):
    sleeper = [PY, "-c", "import time; time.sleep(60)"]
    sup = Supervisor(sleeper, sleeper, tmp_path, log=lambda _t: None)
    try:
        sup.step()
        first = sup.children["vision"].pid
        sup.children["vision"].kill()
        killed = time.monotonic()
        assert wait_for(lambda: (sup.step(), sup.children["vision"].pid != first and sup.children["vision"].poll() is None)[1], 2.0)
        assert time.monotonic() - killed < 1.0
        assert sup.restarts == {"vision": 1, "guard": 0}
    finally:
        sup.stop()


def test_it_stops_both_children_on_sigterm(tmp_path):
    script = f"import sys; sys.path.insert(0, r'{HERE}'); from supervisor import main; main()"
    sleeper = f"{PY} -c 'import time; time.sleep(60)'"
    proc = subprocess.Popen([PY, "-c", script, "--vision", sleeper, "--guard", sleeper, "--data", str(tmp_path)], stderr=subprocess.PIPE, text=True)
    pids = []
    try:
        for text in proc.stderr:
            if "pid" in text:
                pids.append(int(text.split("pid ")[1].split(")")[0]))
            if len(pids) == 2:
                break
        proc.send_signal(signal.SIGTERM)
        assert proc.wait(8) == 0
        for pid in pids:
            assert wait_for(lambda p=pid: not Path(f"/proc/{p}").exists() or "Z" in Path(f"/proc/{p}/stat").read_text().split()[2], 3.0)
    finally:
        if proc.poll() is None:
            proc.kill()
