# Benchmark results

Run directories and private reveal mappings are local and ignored. Only JSON
schemas and this documentation are tracked. TTS runs also retain prepare timing,
after-prepare cold timing, process-attributed RSS peaks, and VRAM only when the
candidate runtime exposes a process allocator counter. Validate a run with:

```sh
uv run python -m benchmarks.harness validate benchmarks/results/<run-directory>
```
