# Synthetic audio fixtures

`generate.py` creates deterministic 16 kHz mono PCM16 WAV tones from the tracked
specifications in `benchmarks/datasets/synthetic.manifest.json`. Generated WAVs
remain ignored; the harness verifies the canonical fixture specification hash
before creating any stream.
