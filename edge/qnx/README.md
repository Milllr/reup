# Shelf node (Raspberry Pi 5, QNX 8)

Two parts:

* `vision/`: C++. Camera frames from the QNX sensor framework, the TFLite hand model, reach detection and pocket counts. It starts from github.com/qnx/QNX-AI-workshop, which QNX verified with the Logitech C270.
* `guard/`: the ledger, the offline queue, the reorder guard and the button. Python standard library only if the image has Python with sqlite3 and ssl; otherwise it is rebuilt in C++ from the same tests.

The four levels, the process layout and the judge demo are in docs/features.json (F14 to F19) and docs/FLOWS.md.

Nothing here builds in CI. CI runs the guard's unit tests with normal Python and the pocket math tests compiled with g++ on the host.
