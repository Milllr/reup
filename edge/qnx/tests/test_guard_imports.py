"""The guard must import with nothing but the standard library: that is all the QNX image is known to have."""
import importlib
import sys


def test_guard_imports_with_the_standard_library_only():
    before = set(sys.modules)
    importlib.import_module("guard")
    added = {m.split(".")[0] for m in set(sys.modules) - before}
    assert added <= {"guard"} | set(sys.stdlib_module_names)
