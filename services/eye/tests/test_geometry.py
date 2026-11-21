import numpy as np
import pytest

from reup_eye import geometry as G

QUAD = [[0.1, 0.2], [0.7, 0.25], [0.75, 0.8], [0.05, 0.7]]


def test_the_flat_rectangle_maps_onto_the_four_corners_of_the_quad():
    assert G.apply(G.unit_to_quad(QUAD), G.UNIT) == pytest.approx(np.array(QUAD))


def test_the_four_cell_corners_of_a_grid_are_the_four_corners_of_the_zone():
    rows, cols = 2, 6
    corners = [G.cell_corners(QUAD, rows, cols, i) for i in range(rows * cols)]
    assert corners[0][0] == pytest.approx(QUAD[0])
    assert corners[cols - 1][1] == pytest.approx(QUAD[1])
    assert corners[-1][2] == pytest.approx(QUAD[2])
    assert corners[(rows - 1) * cols][3] == pytest.approx(QUAD[3])
    # Neighbours share an edge.
    assert corners[0][1] == pytest.approx(corners[1][0])


def test_pocket_cells_are_numbered_row_by_row_from_the_top_left():
    assert G.cell_rect(2, 6, 0) == (0.0, 0.0, 1 / 6, 0.5)
    assert G.cell_rect(2, 6, 5) == pytest.approx((5 / 6, 0.0, 1.0, 0.5))
    assert G.cell_rect(2, 6, 6) == (0.0, 0.5, 1 / 6, 1.0)
    square = [[0, 0], [1, 0], [1, 1], [0, 1]]
    centres = G.cell_samples(square, 2, 3, n=4).mean(axis=1)
    assert centres[:, 0] == pytest.approx([1 / 6, 0.5, 5 / 6, 1 / 6, 0.5, 5 / 6])
    assert centres[:, 1] == pytest.approx([0.25, 0.25, 0.25, 0.75, 0.75, 0.75])


def test_samples_stay_inside_their_pocket_away_from_the_walls():
    pts = G.cell_samples([[0, 0], [1, 0], [1, 1], [0, 1]], 1, 2, n=6, inset=0.2)
    assert pts.shape == (2, 36, 2)
    assert pts[0][:, 0].min() >= 0.1 and pts[0][:, 0].max() <= 0.4
    assert pts[1][:, 0].min() >= 0.6 and pts[1][:, 0].max() <= 0.9


def test_a_point_is_found_in_the_quad_that_holds_it_whichever_way_it_winds():
    assert G.point_in_quad((0.4, 0.5), QUAD)
    assert G.point_in_quad((0.4, 0.5), QUAD[::-1])
    assert not G.point_in_quad((0.9, 0.5), QUAD)


def test_border_points_are_on_bare_board_outside_every_zone():
    zone = [[0.2, 0.2], [0.6, 0.2], [0.6, 0.6], [0.2, 0.6]]
    pts = G.border_samples(G.UNIT, [zone])
    assert len(pts) > 100
    assert not any(G.point_in_quad(p, zone) for p in pts)


def test_an_outline_is_simplified_to_at_most_24_points_and_keeps_its_shape():
    angles = np.linspace(0, 2 * np.pi, 400, endpoint=False)
    circle = np.c_[0.5 + 0.2 * np.cos(angles), 0.5 + 0.2 * np.sin(angles)]
    out = np.array(G.simplify(circle, 24))
    assert 8 <= len(out) <= 24
    assert np.hypot(out[:, 0] - 0.5, out[:, 1] - 0.5) == pytest.approx(0.2, abs=1e-6)
    assert G.simplify([[0, 0], [1, 0], [1, 1]], 24) == [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0]]


def test_the_hull_of_a_filled_square_is_its_four_corners():
    pts = [(x / 4, y / 4) for x in range(5) for y in range(5)]
    assert sorted(G.hull(pts)) == [[0.0, 0.0], [0.0, 1.0], [1.0, 0.0], [1.0, 1.0]]
