"""Python mirror of the shapes the eye sends, from contracts/src/schema.ts and contracts/src/api.ts.

The TypeScript files are the source of truth. tests/test_contracts.py checks these models against the same
mock files the TypeScript tests use, so a drift on either side fails CI. Field names are camelCase on the wire.
"""
from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, conlist

Point = conlist(float, min_length=2, max_length=2)
CameraId = Literal["board", "aux", "node"]
CountSource = Literal["eye", "node", "manual", "seed"]


class Wire(BaseModel):
    """Reject unknown fields so a renamed contract field is caught, and keep the wire names as they are."""

    model_config = ConfigDict(extra="forbid")


class Zone(Wire):
    id: str
    name: str
    kind: Literal["pockets", "open", "bin"]
    camera: CameraId
    quad: conlist(Point, min_length=4, max_length=4)
    rows: Optional[int]
    cols: Optional[int]
    productId: Optional[str]


class Count(Wire):
    productId: str
    zoneId: str
    count: int = Field(ge=0)
    level: Optional[float] = Field(default=None, ge=0, le=1)
    pockets: Optional[list[bool]] = None
    source: CountSource
    ts: AwareDatetime


class PickEvent(Wire):
    id: str
    productId: str
    zoneId: str
    delta: int
    countAfter: int = Field(ge=0)
    source: CountSource
    handSeen: bool
    ts: AwareDatetime


class Camera(Wire):
    id: CameraId
    online: bool
    fps: float = Field(ge=0)
    streamUrl: Optional[str]


class IngestCountsBody(Wire):
    counts: conlist(Count, min_length=1)
    cameras: Optional[list[Camera]] = None


class IngestPicksBody(Wire):
    picks: conlist(PickEvent, min_length=1)


class TeachBody(Wire):
    jpegBase64: str = Field(min_length=1)
    zoneId: Optional[str]


def now_iso() -> str:
    """The time format every contract uses: ISO 8601 with an offset."""
    return datetime.now().astimezone().isoformat(timespec="seconds")
