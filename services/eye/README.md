# Eye

Counts the parts board from the laptop's two cameras, serves the live picture to the TV, and tells the hub when a count changes.

## Run it

All commands run from `services/eye`.

* Install: `python -m pip install -r requirements.txt`
* Find the cameras: `python -m reup_eye --list-cameras`
* Run: `python -m reup_eye --hub http://localhost:3000`
* With no cameras, a drawn board for development: `python -m reup_eye --hub http://localhost:3000 --sim`
* Tests, from the repo root: `npm run test:py`

`DEVICE_TOKEN` comes from the environment (Infisical). Settings are in `config.toml`.

## First run on the real board

1. Open `http://localhost:8089/debug/board.jpg`. The white shapes are the zones the hub knows. Draw them on the operator page until they sit on the board.
2. Take every part off the board. Save the empty board: `curl -X POST http://localhost:8089/reference/board`
3. Take everything off the teach spot. Save it too: `curl -X POST http://localhost:8089/reference/aux`
4. Put the parts back. The debug picture shows a number in every pocket: its difference from the empty board. Full pockets should read well over `threshold` in `config.toml` (18) and empty ones well under. Change `threshold` if they do not.

The empty board is saved in `data/` and survives a restart. Save it again whenever a camera or the board moves.

## Local routes, port 8089

| Method | Path | What |
| --- | --- | --- |
| GET | /stream/board.mjpg, /stream/aux.mjpg | The live picture |
| GET | /outlines/board.json | The outline of every item it sees, normalized |
| GET | /debug/board.jpg | The frame with zones, pockets and their numbers drawn |
| POST | /reference/board, /reference/aux | Save the empty board |
| POST | /prompt/:zoneId | Save what is in an open zone now as its part's example picture, for YOLOE. Put exactly one there first |
| GET | /health | What the eye thinks, as JSON |
| POST | /sim/take?zone=z-screws&n=2, /sim/put, /sim/set, /sim/teach?on=1, /sim/dim?to=0.67 | The drawn board only |

## How it counts

* The frame is averaged down to a quarter size, in colour. Colour matters: a box can be exactly as bright as the wood.
* Brightness is corrected first, using bare board outside every zone, so dimming the lights changes nothing.
* A pocket is full when its mean difference from the empty board is over `threshold`.
* Nothing is counted while anything moves on the board. A count is posted after 500 ms of stillness, only when it changed, and once every 30 seconds as a keepalive.
* Open zones: YOLOE-26 counts a part once it has an example picture (from the teach spot, or `/prompt/:zoneId`) and ultralytics is installed. Otherwise the eye counts difference blobs against the empty board, and says so in its log.
* The teach spot: a new item that holds still for 1 second is cropped and sent to the hub once. The next one needs the spot empty for 2 seconds first.

## The TV and the stream

The stream address the eye gives the hub is `http://localhost:8089/...` by default, so the TV's browser must run on this laptop. That is on purpose: a page served over https may only load local video from localhost. To show the TV page from another machine, set `public_host` in `config.toml` to this laptop's LAN address and open the hub over http.

## Where things are

| File | What |
| --- | --- |
| reup_eye/geometry.py, frames.py, counting.py, teach.py | The pure parts, numpy only, all unit tested |
| reup_eye/app.py | What the eye knows, one analysis step per frame, what it posts |
| reup_eye/runtime.py | Cameras, threads, OpenCV, the detector loop |
| reup_eye/server.py | The local routes, standard library only |
| reup_eye/detector.py | YOLOE-26, imported only when asked for |
| reup_eye/sim.py | The drawn board |
