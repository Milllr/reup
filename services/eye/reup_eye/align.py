"""Keeps the picture lined up with where the camera was when the zones were drawn.

A bumped camera slides and turns the picture a little. The eye compares the edges in each frame (the ledges, the board's
outline, the tape) with the edges it saved at the camera's home position, works out the slide and the turn, and moves
every frame back before anything else looks at it. Zones, the empty board and the stream then stay true.

Edges of the whole picture, not points on the parts: tried on frames of the board as built, points lived on the labels
of the parts and were gone when the parts were, while the edges gave the same answer with six parts painted out.
"""
from __future__ import annotations

import math
from typing import Optional

import numpy as np

WIDTH, HEIGHT = 480, 270  # the size the edges are compared at


def edges(cv2, frame: np.ndarray) -> np.ndarray:
    """The picture as soft edges, WIDTH by HEIGHT, float32."""
    grey = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY) if frame.ndim == 3 else frame
    grey = cv2.resize(grey, (WIDTH, HEIGHT), interpolation=cv2.INTER_AREA).astype(np.float32)
    grey = cv2.GaussianBlur(grey, (0, 0), 1.5)
    strength = cv2.magnitude(cv2.Sobel(grey, cv2.CV_32F, 1, 0, ksize=3), cv2.Sobel(grey, cv2.CV_32F, 0, 1, ksize=3))
    return cv2.GaussianBlur(strength, (0, 0), 1.0)


def estimate(cv2, home: np.ndarray, now: np.ndarray, window: Optional[np.ndarray] = None, also: Optional[np.ndarray] = None) -> Optional[dict]:
    """How to move the picture now back onto home: a slide and a turn. None when the two cannot be compared.

    matrix is 2 by 3 at WIDTH by HEIGHT. phase is how sure the slide is (about 0.3 to 0.7 for the same board, 0.03 for
    something else), match is how alike the edges are once lined up.

    Parts in a row repeat, so a slide of one part's width can look right too. The fit is run from three starts: the
    move in use now (also, or no move), the slide the phase suggests, and the slide the phase suggests on blurred
    edges, where the parts wash out. Staying put wins unless another fit is clearly better.
    """
    if window is None:
        window = cv2.createHanningWindow((WIDTH, HEIGHT), cv2.CV_32F)
    # Copies: phaseCorrelate multiplies the window into the pictures it is given, and home is kept for every later look.
    (dx, dy), phase = cv2.phaseCorrelate(now.copy(), home.copy(), window)
    # The same again on blurred edges: small things that repeat wash out, the board's outline and the ledges stay.
    (cx, cy), _coarse = cv2.phaseCorrelate(cv2.GaussianBlur(now, (0, 0), 4.0), cv2.GaussianBlur(home, (0, 0), 4.0), window)
    stay = np.array([[1, 0, 0], [0, 1, 0]], dtype=np.float32) if also is None else cv2.invertAffineTransform(np.asarray(also, dtype=np.float32))
    fits = []
    for start in (stay, np.array([[1, 0, -dx], [0, 1, -dy]], dtype=np.float32), np.array([[1, 0, -cx], [0, 1, -cy]], dtype=np.float32)):
        try:
            match, found = cv2.findTransformECC(home, now, start.copy(), cv2.MOTION_EUCLIDEAN, (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 60, 1e-5), None, 5)
            fits.append((float(match), found))
        except cv2.error:
            continue
    if not fits:
        return None
    # Staying where the picture is wins unless the other fit is clearly better.
    match, found = fits[0] if fits[0][0] >= 0.93 * max(f[0] for f in fits) else max(fits, key=lambda f: f[0])
    return {"matrix": cv2.invertAffineTransform(found).astype(np.float64), "phase": float(phase), "match": match}


def moved(matrix: np.ndarray, width: float = WIDTH, height: float = HEIGHT) -> float:
    """How far the matrix moves the corner or the middle of the picture that it moves most, in pixels."""
    points = np.array([[0, 0, 1], [width, 0, 1], [width, height, 1], [0, height, 1], [width / 2, height / 2, 1]], dtype=float)
    return float(np.abs(points @ np.asarray(matrix, dtype=float).T - points[:, :2]).max())


def turn(matrix: np.ndarray) -> float:
    """The turn in the matrix, in degrees."""
    return math.degrees(math.atan2(matrix[1][0], matrix[0][0]))


def for_frame(matrix: np.ndarray, frame_width: int) -> np.ndarray:
    """The same move for a frame of another width: the turn stays, the slide grows with the picture."""
    out = np.array(matrix, dtype=np.float64)
    out[:, 2] *= frame_width / WIDTH
    return out


IDENTITY = np.array([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]])


class Steady:
    """Decides which move to apply, from one estimate a second. Nothing here needs OpenCV.

    A move is taken up after two estimates in a row agree, so one bad look never shifts the picture. A move under dead
    pixels is no move: the zones have that much room, and a picture that is never touched cannot jitter. An estimate the
    eye is not sure of changes nothing, and after hold of them in a row the view counts as hidden.
    """

    def __init__(self, min_phase: float = 0.1, min_match: float = 0.3, hidden_phase: float = 0.06, dead: float = 2.0, agree: float = 1.0, max_shift: float = 0.2, max_turn: float = 4.0, hold: int = 2):
        self.min_phase, self.min_match, self.hidden_phase = min_phase, min_match, hidden_phase
        self.dead, self.agree, self.max_shift, self.max_turn, self.hold = dead, agree, max_shift, max_turn, hold
        self.matrix = IDENTITY.copy()
        self.pending: Optional[np.ndarray] = None
        self.blind = 0
        self.hidden = False
        self.too_far = False
        self.last: dict = {}

    def is_moved(self) -> bool:
        return moved(self.matrix) >= self.dead

    def update(self, found: Optional[dict]) -> bool:
        """Takes one estimate. Returns True when the move to apply changed."""
        phase = found["phase"] if found else 0.0
        match = found["match"] if found else 0.0
        self.last = {"phase": round(phase, 3), "match": round(match, 3)}
        if found is None or phase < self.min_phase or match < self.min_match:
            self.pending = None
            self.blind = self.blind + 1 if phase < self.hidden_phase else 0
            self.hidden = self.blind >= self.hold
            return False
        self.blind = 0
        self.hidden = False
        matrix = found["matrix"]
        shift = moved(matrix)
        self.last["moved"] = round(shift, 2)
        self.too_far = shift > self.max_shift * WIDTH or abs(turn(matrix)) > self.max_turn
        if self.too_far:
            self.pending = None
            return False
        target = IDENTITY.copy() if shift < self.dead else matrix
        if moved(_between(target, self.matrix)) < self.agree:
            self.pending = None
            return False  # already where it should be
        if self.pending is not None and moved(_between(target, self.pending)) < self.agree:
            self.matrix, self.pending = target, None
            return True
        self.pending = target
        return False

    def reset(self) -> None:
        self.matrix, self.pending, self.blind, self.hidden, self.too_far = IDENTITY.copy(), None, 0, False, False


def _between(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """The move that is left when b is taken out of a. Identity when they are the same."""
    full = lambda m: np.vstack([m, [0, 0, 1]])  # noqa: E731
    return (full(a) @ np.linalg.inv(full(b)))[:2]
