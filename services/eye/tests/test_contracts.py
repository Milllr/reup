"""The eye's models must accept the shared mocks, and reject what the contract rejects."""
import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from reup_eye import contracts as C

MOCKS = Path(__file__).resolve().parents[3] / "contracts" / "mocks"


def load(name: str):
    return json.loads((MOCKS / f"{name}.json").read_text(encoding="utf-8"))


def test_count_mock_matches():
    assert C.Count.model_validate(load("count")).count == 4


def test_pick_mock_matches():
    assert C.PickEvent.model_validate(load("pick")).delta == -2


def test_ingest_bodies_match():
    C.IngestCountsBody.model_validate(load("ingest-counts"))
    C.IngestPicksBody.model_validate(load("ingest-picks"))


def test_every_zone_in_the_snapshot_matches():
    zones = [C.Zone.model_validate(z) for z in load("snapshot")["zones"]]
    assert len(zones) == 4


def test_a_count_below_zero_is_rejected():
    bad = {**load("count"), "count": -1}
    with pytest.raises(ValidationError):
        C.Count.model_validate(bad)


def test_an_unknown_field_is_rejected():
    bad = {**load("count"), "units": 4}
    with pytest.raises(ValidationError):
        C.Count.model_validate(bad)


def test_now_iso_has_an_offset():
    C.Count.model_validate({**load("count"), "ts": C.now_iso()})
