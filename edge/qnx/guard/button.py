"""The wooden button. Presses within one second count once."""
from __future__ import annotations

from typing import Callable, Optional


class Debounce:
    def __init__(self, quiet_s: float = 1.0):
        self.quiet_s = quiet_s
        self.last: Optional[float] = None
        self.was_down = False

    def press(self, now: float) -> bool:
        """A press happened. True when it counts."""
        if self.last is not None and now - self.last < self.quiet_s:
            return False
        self.last = now
        return True

    def level(self, down: bool, now: float) -> bool:
        """For a pin that is polled: True on the moment it goes down, once."""
        edge = down and not self.was_down
        self.was_down = down
        return edge and self.press(now)


class Presses:
    """Turns a pin that is polled into presses, and never takes the level the pin starts at for one.

    A press counts only after the pin was seen at rest for rest_s, and then down for firm_s. A pin that reads down from
    the first look (nothing wired to it, a floating pin, a stuck button) never counts. Without this a guard that starts
    while an order waits would say yes to it by itself. Seen on the Pi: every free pin read high at start.
    """

    def __init__(self, rest_s: float = 0.3, firm_s: float = 0.04):
        self.rest_s = rest_s
        self.firm_s = firm_s
        self.up_since: Optional[float] = None
        self.down_since: Optional[float] = None
        self.armed = False

    def look(self, down: bool, now: float) -> bool:
        """One look at the pin. True on the moment a press counts, once for each press."""
        if not down:
            self.down_since = None
            if self.up_since is None:
                self.up_since = now
            if now - self.up_since >= self.rest_s:
                self.armed = True
            return False
        self.up_since = None
        if not self.armed:
            return False
        if self.down_since is None:
            self.down_since = now
        if now - self.down_since >= self.firm_s:
            self.armed = False
            return True
        return False


def pin_reader(pin: int, path: str = "", log: Callable[[str], None] = print) -> Optional[Callable[[], bool]]:
    """Something that says whether the button is down, or None when there is no way to read it on this machine.

    Tried in order: a file that holds 0 or 1 (GUARD_BUTTON_FILE), then the rpi_gpio module that ships on the QNX image.
    The pin is a BCM number. The Grove button pulls its pin high when pressed.
    """
    if path:
        def from_file() -> bool:
            try:
                with open(path, encoding="ascii") as f:
                    return f.read().strip() == "1"
            except OSError:
                return False

        return from_file
    try:
        import rpi_gpio as gpio  # noqa: PLC0415  on the Pi only

        gpio.setmode(gpio.BCM)
        gpio.setup(pin, gpio.IN, gpio.PUD_DOWN)
        return lambda: gpio.input(pin) == gpio.HIGH
    except Exception as err:  # noqa: BLE001
        log(f"No button: {err}. Approve from a phone instead.")
        return None
