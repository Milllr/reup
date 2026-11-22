#!/bin/sh
# What to show a QNX judge, with the exact commands. Run it in a second terminal next to run.sh.
cd "$(dirname "$0")" || exit 1
DATA="${GUARD_DATA:-$PWD/data}"
cat <<TEXT
reup shelf node: what to show

1. The screen. QNX's hand model runs on the Pi, on the live video of the board, with its own numbers on it.
   Put a hand in: the skeleton follows it.

2. Every reach is on the Pi's disk before it is sent anywhere.
     tail -n 4 $DATA/ledger.jsonl

3. Kill the vision process. It is ready again in about 3.5 seconds, and the ledger never stopped.
     slay -f handtrack_node
   Then show:
     pidin | grep handtrack_node        (a new process id)
     cat $DATA/restarts.json            (the count went up by one; the operator page shows it too)
   While it is down the heartbeat still goes: it belongs to the guard, a separate process.
   The guard runs at priority 20, above vision at 10:
     pidin -F "%a %p %n" | grep -e python3 -e handtrack_node

Not on this station: counts on the Pi itself, and the reorder call with the network cable out. Both need the node
to count the board, and this board has ledges where the node counts pockets. The laptop counts and buys.
TEXT
