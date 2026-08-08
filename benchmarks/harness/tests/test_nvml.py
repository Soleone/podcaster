from __future__ import annotations

import subprocess

from benchmarks.harness import nvml


def test_nvml_unavailable_is_honest(monkeypatch) -> None:
    monkeypatch.setattr(nvml.shutil, "which", lambda _: None)
    sample = nvml.sample_gpu()
    assert not sample.available
    assert sample.used_bytes == 0
    assert "unavailable" in sample.reason


def test_repeated_sampler_collects_each_sample() -> None:
    calls = 0

    def fake_sample() -> nvml.GpuSample:
        nonlocal calls
        calls += 1
        return nvml.GpuSample(True, used_bytes=calls)

    samples = nvml.RepeatedGpuSampler(fake_sample).collect(3)
    assert [sample.used_bytes for sample in samples] == [1, 2, 3]


def test_nvml_sample_parses_bytes(monkeypatch) -> None:
    monkeypatch.setattr(nvml.shutil, "which", lambda _: "/usr/bin/nvidia-smi")
    monkeypatch.setattr(
        nvml.subprocess,
        "run",
        lambda *args, **kwargs: subprocess.CompletedProcess(
            args[0], 0, "NVIDIA GeForce RTX 4090, 610.43.02, 4511\n", ""
        ),
    )
    sample = nvml.sample_gpu()
    assert sample.available
    assert sample.name == "NVIDIA GeForce RTX 4090"
    assert sample.used_bytes == 4511 * 1024 * 1024
