# Eye

Counts the parts board from the laptop's camera, serves the live picture to the TV, and tells the hub when a count changes.

The station as built has one laptop camera, the Facecam, called `board`. A second one, `aux`, is off in `config.toml`.

## Run it

All commands run from `services/eye`.

* Install: `python -m pip install -r requirements.txt`
* Find the cameras: `python -m reup_eye --list-cameras`. It prints their names and opens none of them.
* Run: `python -m reup_eye --hub http://localhost:3000`
* With no cameras, a drawn board for development: `python -m reup_eye --hub http://localhost:3000 --sim`
* Tests, from the repo root: `npm run test:py`

`DEVICE_TOKEN` comes from the environment (Infisical). Settings are in `config.toml`.

## First run on the real board

The station as built has ledges and no pockets, and the detector counts them. It needs no empty board:

1. Set the board on the hub, from the repo root: `npm run board -- http://localhost:3000`
2. Open `http://localhost:8089/debug/board.jpg`. The white shapes are the zones. Move them on the operator page until each one covers its ledge, with room to spare.
3. Give the detector one example of each part. Read the corners of one part off the picture, as shares of its width and height: `curl -X POST "http://localhost:8089/prompt/z-9v?box=0.61,0.71,0.64,0.80"`. Do the same for every ledge.
4. `http://localhost:8089/health` shows the counts. They follow the board within a second, however many are stocked.

The examples are kept in `data/prompts/` and survive a restart. Save new ones if the lighting or the parts change a lot.

For pockets and difference blobs, the eye compares with the empty board. The teach spot needs none of this: it learns its own empty look in the first second after the eye starts.

1. Open `http://localhost:8089/debug/board.jpg`. The white shapes are the zones the hub knows. Draw them on the operator page until they sit on the board.
2. Take every part off the board. Save the empty board: `curl -X POST http://localhost:8089/reference/board`, or "Capture empty board" on the operator page.
3. Fill the board: every ledge holds as many as its part's capacity. Save the full board: `curl -X POST http://localhost:8089/full/board`, or "Capture full board". If a ledge holds another number, say so: `curl -X POST "http://localhost:8089/full/board?z-glue=3"`
4. Take parts off and put them back. `http://localhost:8089/health` shows every count. For a pocket zone the debug picture shows a number in every pocket: its difference from the empty board. Full pockets should read well over `threshold` in `config.toml` (18) and empty ones well under. Change `threshold` if they do not.

The empty board and the size of one unit are saved in `data/` and survive a restart. Save both again whenever the camera or the board moves, and draw the zones again first.

## Keeping it running on the station laptop

The eye is started by a watchdog and never by hand. The watchdog starts it again when it stops, stops answering, or gets no frames from the camera for 20 seconds, and it picks the python that has the eye's packages whatever shell it is run from.

* Start it once and leave it: `powershell -NoProfile -ExecutionPolicy Bypass -File services\eye\keep_alive.ps1`
* New code: `powershell -NoProfile -ExecutionPolicy Bypass -File services\eye\restart.ps1` puts the checkout on `origin/main`, restarts the eye and prints what it sees. `-Ref` names another branch.
* Every restart and its reason is a line in `data\watchdog.log`. The eye's own words are in `data\eye.log` and `data\eye.err`, and the run before in the same names with `.last`.
* Measured on the laptop: killed, the eye answers again after 9 seconds, has the camera after 11, and counts after 37 (the detector loads its model).
* After a reboot the watchdog has to be started again. It is one process, not a service.
* The board page opens the picture again by itself when the eye comes back, so nobody has to reload it.

## When the camera gets bumped

The first time the eye runs with a still picture it saves the edges of that picture as the camera's home position (`data/home-board.npy`). About once a second, and after anything moves, it compares the picture with home and works out the slide and the turn between them. A picture that moved is moved back before the stream, the zones or the detector see it, so nothing has to be drawn again.

* Tried on real frames of the board as built, slid and turned in software, with six parts painted out: bumps of up to 200 pixels of a 1280 wide frame and 1.5 degrees were put back to within 3 pixels. Not yet tried with a real bump of the real camera.
* A move under 8 pixels of the frame is left alone. Past a fifth of the picture's width or 4 degrees the camera has a new home: draw the zones again, then press "Set camera position" on the operator page (`POST /anchor/board`).
* After anything moves, counts wait for one look that says the camera is where it should be. That adds about 0.2 s and never more than 3.
* When the eye cannot find the board at all (someone stands in front of it), counts are held for up to 15 seconds and the debug picture says so.
* `aligned` in `/health` shows the move in use and how sure the last look was. `[align] enabled = false` in `config.toml` turns it all off.

## Cameras

* A camera with a `name` in `config.toml` is only ever opened under that name. If it is unplugged, or the names cannot be listed (`cv2-enumerate-cameras` is not installed), nothing is opened in its place. The eye can not end up looking through a built in webcam.
* On Windows the eye opens the camera through Media Foundation, then DirectShow. On this laptop DirectShow refuses the Facecam MK.2 ("can't be used to capture by index") and Media Foundation gives 1080p at 30.
* A camera with `enabled = false` is never opened. Turn `aux` on only with a name.
* Motion is watched inside the board only. Name its corners with `board` in `config.toml`, or leave it and the eye uses a box around the zones (the thin grey box in the debug picture).
* The hub is called with the User-Agent `reup-eye/1`. Cloudflare answers Python's default one with 403, error 1010.

## Local routes, port 8089

| Method | Path | What |
| --- | --- | --- |
| GET | /stream/board.mjpg | The live picture |
| GET | /outlines/board.json | The outline of every item it sees, normalized. A part that sits in another part's box carries `zoneId`, the box it is in |
| GET | /debug/board.jpg | The frame with zones, pockets and their numbers drawn |
| POST | /reference/board | Save the empty board |
| POST | /anchor/board | This is where the camera sits now. Later pictures are lined up with this one |
| POST | /full/board | With the board full, save the size of one unit for every open zone. `?z-id=n` when a zone holds n and not its part's capacity |
| POST | /teach | Name whatever is on the teach spot now. For a part the eye did not find by itself. The board's menu has it as "Name what is on the teach spot" |
| POST | /prompt/:zoneId?box=x0,y0,x1,y1 | Save the frame as the example of that zone's part, with the box around one of it. With no box the whole zone is the example, so put exactly one there first |
| GET | /health | What the eye thinks, as JSON |
| POST | /sim/take?zone=z-screws&n=2, /sim/put, /sim/set, /sim/teach?on=1, /sim/dim?to=0.67 | The drawn board only |

## How it counts

* The frame is averaged down to a quarter size, in colour. Colour matters: a box can be exactly as bright as the wood.
* Brightness is corrected first, using bare board outside every zone, so dimming the lights changes nothing.
* A pocket is full when its mean difference from the empty board is over `threshold`.
* Nothing is counted while anything moves on the board. A count is posted after 500 ms of stillness, only when it changed, and once every 30 seconds as a keepalive.
* Open zones: YOLOE-26 counts a part once it has an example (from the teach spot, or `/prompt/:zoneId`) and ultralytics is installed. An example is a whole frame and the box of one of the part in it. A count is believed after 3 looks in a row with nothing moving. Otherwise the eye counts difference blobs against the empty board, and says so in its log.
* On the demo laptop's GPU a look takes about 45 ms. That needs the CUDA build of PyTorch: `python -m pip install --force-reinstall torch torchvision --index-url https://download.pytorch.org/whl/cu130`. On a CPU a look takes 0.3 s, which still works.
* Parts that stand side by side on a ledge touch, and touching parts are one blob. Once the full board is saved the eye knows the size of one unit in each open zone, so a blob counts as its size divided by that, and a patch under 0.3 of a unit is not a part.
* A part in another part's box: the detector finds every part anywhere on the board, so a bolt on the washers' ledge is seen as a bolt. It is in no count. Once the model is sure of it (`open.wrong_conf`, 0.5), it is not the same thing as a part at home in that box, and it has stayed for `open.wrong_hold` looks in a row (8, about a second), the board draws it in orange and says "1 from hex bolts is in the washers box. Not counted." `wrong_hold = 0` turns this off.
* The teach spot is the hub's `z-teach` zone, a clear patch of the board. A new item that holds still for 1.5 seconds is sent to the hub once, as a picture of the spot in its own shape with a fifth of its size of board around it (`teach.view`), so a part at the edge of the spot is whole in the picture. The next one needs the spot empty for 2 seconds first. A part that is given a box of its own on the new part screen is learned the same way: the eye finds its product by the card's picture.
* Start the eye with the teach spot empty. The eye takes the first still second as the empty spot and follows slow changes in the light after that. A part is one patch, over 1 percent of the spot, of another colour than the wood, or nearly black. A shadow or a lamp changes how bright the wood is and not its colour, so neither is a part. A part the colour of the board is not seen: put it down label up. The eye also looks a fifth of the spot past each of its edges (`teach.reach`). A part sits inside the spot, so a patch that runs out past that margin is an arm, reaching for the ledge next door or putting a part down: while it is there no new part is announced and a part that waits for its name is not taken for lifted off. The health page says `reaching` when it sees one.
* Whatever stays on the spot for 20 seconds with no card up (the hub took the card down, or could not be reached) stops being new. Taking it away is not a new part either. To teach it after all, lift it for 2 seconds and put it down again.

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
