from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class EndpointerConfig:
    """Deterministic matched-candidate endpoint policy; not hardware-calibrated."""

    sample_rate: int = 16_000
    frame_ms: int = 20
    speech_threshold_rms: int = 180
    speech_start_frames: int = 3
    speech_end_frames: int = 20

    def __post_init__(self) -> None:
        if self.sample_rate != 16_000 or self.frame_ms <= 0:
            raise ValueError("T3 endpointer requires positive 16 kHz frames")
        if min(self.speech_threshold_rms, self.speech_start_frames, self.speech_end_frames) < 1:
            raise ValueError("endpointer thresholds must be positive")


@dataclass
class DeterministicEndpointer:
    """RMS endpoint seam shared by matched STT candidates.

    It operates only on complete little-endian PCM16 mono frames and exposes transitions.
    Thresholds are experimental configuration, not a calibrated product VAD.
    """

    config: EndpointerConfig
    in_speech: bool = False
    _speech_frames: int = 0
    _silence_frames: int = 0

    def reset(self) -> None:
        self.in_speech = False
        self._speech_frames = 0
        self._silence_frames = 0

    def accept(self, pcm: bytes) -> str | None:
        expected = self.config.sample_rate * self.config.frame_ms // 1000 * 2
        if len(pcm) != expected or len(pcm) % 2:
            raise ValueError(f"VAD frame must be exactly {expected} PCM16 bytes")
        count = len(pcm) // 2
        energy = sum(int.from_bytes(pcm[i : i + 2], "little", signed=True) ** 2 for i in range(0, len(pcm), 2))
        rms = int((energy / count) ** 0.5)
        if rms >= self.config.speech_threshold_rms:
            self._speech_frames += 1
            self._silence_frames = 0
            if not self.in_speech and self._speech_frames >= self.config.speech_start_frames:
                self.in_speech = True
                return "speech_start"
        else:
            self._speech_frames = 0
            if self.in_speech:
                self._silence_frames += 1
                if self._silence_frames >= self.config.speech_end_frames:
                    self.in_speech = False
                    self._silence_frames = 0
                    return "speech_end"
        return None
