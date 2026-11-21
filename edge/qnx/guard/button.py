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


def pin_reader(pin: int, path: str = "", log: Callable[[str], None] = print) -> Optional[Callable[[], bool]]:
    """Something that says whether the button is down, or None when there is no way to read it on this machine.

    Tried in order: a file that holds 0 or 1 (GUARD_BUTTON_FILE), then the rpi_gpio module that ships on the QNX image.
    The Grove button pulls its pin high when pressed.
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

        gpio.setup(pin, gpio.IN, gpio.PUD_DOWN)
        return lambda: gpio.input(pin) == gpio.HIGH
    except Exception as err:  # noqa: BLE001
        log(f"No button: {err}. Approve from a phone instead.")
        return None
