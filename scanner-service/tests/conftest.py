import pytest


class ScriptedTransport:
    """Transport that replays scripted IN transfers and records OUT writes."""

    def __init__(self, reads):
        self.reads = list(reads)
        self.writes = []

    def write(self, data):
        self.writes.append(bytes(data))

    def read(self, size):
        if not self.reads:
            raise TimeoutError("no scripted read left")
        chunk = self.reads.pop(0)
        assert len(chunk) <= size, f"scripted chunk {len(chunk)} > requested {size}"
        return chunk


@pytest.fixture
def scripted():
    return ScriptedTransport
