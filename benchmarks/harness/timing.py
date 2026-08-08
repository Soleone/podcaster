"""Versioned real-time pacing thresholds shared by STT runs and validation."""

SOAK_P95_DEADLINE_MS = 20.0
SOAK_MAX_DEADLINE_MS = 100.0


def soak_timing_conforms(soak: dict[str, object]) -> bool:
    return bool(
        soak.get("timingConformance") is True
        and float(soak.get("deadlineLatenessP95Ms", float("inf")))
        <= SOAK_P95_DEADLINE_MS
        and float(soak.get("deadlineLatenessMaxMs", float("inf")))
        <= SOAK_MAX_DEADLINE_MS
    )
