#!/bin/sh
# The three things to show a QNX judge, with the exact commands. Run it in a second terminal next to run.sh.
cd "$(dirname "$0")" || exit 1
DATA="${GUARD_DATA:-$PWD/data}"
cat <<TEXT
reup shelf node: three things to show

1. Kill the vision process. It is back within a second, and the ledger never stopped.
     slay handtrack_node
   Then show:
     pidin | grep handtrack_node        (a new process id)
     cat $DATA/restarts.json            (the count went up by one; the operator page shows it too)
   While it is down the button still approves and the heartbeat still goes: they belong to the guard, a separate process.

2. Pull the network cable. Take two boxes of screws. Wait ten seconds.
   The run.sh window says: The hub has been silent for 10 seconds ... Called for a reorder.
     tail -n 4 $DATA/ledger.jsonl       (the reach, the pick, the count and the reorder call, written before anything was sent)
     wc -l $DATA/outbox.jsonl           (what is waiting for the hub)
   Plug the cable back in. Within five seconds the TV catches up: the count drops and the order opens, called by the node.

3. Press the wooden button while an order is waiting for a yes.
   The run.sh window says: Button pressed. Approved o-...
   The guard runs at priority 20, above vision at 10:
     pidin -F "%a %p %n" | grep -e python3 -e handtrack_node
TEXT
