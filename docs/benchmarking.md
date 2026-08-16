# Reproducible speech benchmark harness

Milestone 2 provides the harness only. It does **not** install or select an STT or
TTS model. Run all commands from the project root with the frozen `uv.lock`.

## Synthetic gate rerun

```sh
uv sync --frozen
uv run pytest benchmarks/harness/tests
run_dir=$(uv run python -m benchmarks.harness run --kind synthetic --config benchmarks/configs/common.yaml | tail -1)
uv run python -m benchmarks.harness validate "$run_dir"
```

A run directory contains `run.json`, `items.jsonl`, `events.jsonl`,
`summary.json`, `ratings.jsonl`, `reveal.sealed.json`, and `README.md`. The pre-gate
artifact `2026-08-07T063248203Z-source-7d645-bb2781d7` is superseded and is not an
accepted schema-compatibility fixture; the accepted Milestone 2 reruns are `a517e378…`
and `e388e755…`. The run
record captures the exact argv, config and dataset hashes, source identity/dirty
state, OS/kernel/CPU/RAM/GPU/driver, Python/Node/CUDA/cuDNN/PyTorch versions,
seed, warmups, repetitions, committed expected source/candidate/attempt tuples,
matched-comparison semantics hash, and status. Configured warmups execute before
measured items and are excluded from aggregates; every dataset source then executes
exactly `repetitions` times with attempts numbered per source/candidate. Validation
requires the measured tuple set to equal the committed set, so removing a complete
source cannot pass validation.
When a runtime or GPU query is unavailable its value is literally `unavailable`;
the harness never invents a version. Synthetic timing uses a virtual monotonic
clock so tests do not claim real model latency.

Run twice and compare deterministic normalized summaries (actual VRAM use is
machine state and is removed only by the explicit normalization command):

```sh
one=$(uv run python -m benchmarks.harness run --kind synthetic --config benchmarks/configs/common.yaml | tail -1)
two=$(uv run python -m benchmarks.harness run --kind synthetic --config benchmarks/configs/common.yaml | tail -1)
uv run python -m benchmarks.harness normalize "$one" > /tmp/podcaster-summary-one.json
uv run python -m benchmarks.harness normalize "$two" > /tmp/podcaster-summary-two.json
cmp /tmp/podcaster-summary-one.json /tmp/podcaster-summary-two.json
```

Run outputs, private reveal mappings, generated WAVs, and model weights are
ignored. Schemas and fixture specifications are tracked.

## Dataset and model checksums

The tracked synthetic dataset stores canonical generator specifications,
`pcm16-sine-v1`, and SHA-256 over the versioned generator identity plus the
specification. The runner generates those exact PCM16LE bytes and feeds them to
the adapter. It can generate the same bytes in a 16-kHz mono WAV for inspection
without tracking audio:

```sh
uv run python packages/test-fixtures/audio/generate.py /tmp/tone.wav --frequency-hz 440 --chunks 8
uv run python -m benchmarks.harness verify --dataset benchmarks/datasets/synthetic.manifest.json
```

Real corpora must remain under `benchmarks/datasets/**/media/`. Record source,
license, acquisition command, version, and SHA-256 in a manifest. Compute a
media checksum with `sha256sum FILE`; never update the expected checksum merely
to make a mismatch pass. Missing files, paths escaping the project, and any
mismatch fail before candidate preparation.

Model manifests used by later milestones must include local `path` and expected
`sha256` fields in addition to the product model metadata. Verify before load:

```sh
uv run python scripts/verify-models.py /path/to/local-model-files.manifest.json
# equivalent:
uv run python -m benchmarks.harness verify --models /path/to/local-model-files.manifest.json
```

No model is acquired by T2.1. A later acquisition command must pin the upstream
revision and license URL and verify bytes before invoking an adapter.

## Adapter boundary and cancellation

Candidates implement `prepare(config)`, `transcribe(stream, cancel)` or
`synthesize(text, cancel)`, `reset()`, and `close()`. The harness establishes a
local cancellation cutoff first. The synthetic fixture records
`cancel_requested` followed by `silence_observed`; failed and cancelled samples
remain in `items.jsonl`. Event sequences are contiguous and monotonic, and
validation rejects backwards timing.

## Blinded listening workflow

For a TTS comparison, use one fixed prompt manifest, headphones, fixed gain, and
at least three listeners. **Assessors receive only `listening.json` and its
opaque `listening-media/` paths; never give them `run.json`, `items.jsonl`, the
run directory browser, or private mapping.** The projection contains no
candidate IDs, machine metrics, or seed. Candidate labels and per-prompt order
are deterministic; the private mapping is mode `0600` outside the run and the
run contains only its SHA-256 commitment.

```sh
view=$(uv run python -m benchmarks.harness listen --runs <candidate-run-a> <candidate-run-b> --assessor <opaque-id> --attempt 1 | tail -1)
comparison_dir=$(dirname "$view")
# Fill a JSON file with dimensions for every presented sample:
# {"ratings":[{"promptLabel":"Prompt 1","samples":[
# {"label":"A","naturalness":1..5,"intelligibility":1..5,"listenability":1..5},
# {"label":"B","naturalness":1..5,"intelligibility":1..5,"listenability":1..5}],
# "preference":"A|B|tie","replayCount":0,"note":"optional"}, ...]}
uv run python -m benchmarks.harness submit-ratings --run "$comparison_dir" --view "$view" --responses responses.json
uv run python -m benchmarks.harness reveal --run "$comparison_dir"
```

The comparison command first validates every source run, requires matching kind,
dataset/hash, comparison-semantics hash, repetitions, and committed source set,
and deterministically selects the declared attempt. Each run gets a distinct
private identity even if model IDs are equal. Candidate identity is excluded from
the comparison-semantics hash, while precision and all shared runtime/chunk/VAD/
endpointer settings remain included and must match. Submission requires every
projected prompt exactly once and per-sample scores covering every presented label
exactly once, validates the complete rating schema and presented labels/order/
preferences, writes a ratings checksum lock, and makes the file
read-only. Reveal records one UTC transition timestamp in the ratings, sealed
mapping, and lock while retaining the immutable pre-reveal submission hash; any
assessor byte edit before or after reveal is refused. Failed samples remain visible
by neutral label. Identity and machine metrics remain hidden until submission.
Report paired raw preference/tie counts; do not claim significance from three
listeners.

## Hardware checks and deviations

Before a real run capture:

```sh
nvidia-smi
nvidia-smi --query-gpu=name,driver_version,memory.total,memory.used --format=csv
ls -l /dev/nvidia* || true  # WSL may expose GPU through /dev/dxg instead
```

T2.1 queries `nvidia-smi` for machine identity and tests a reusable repeated
sampler abstraction. The observed memory reading is ambient machine-wide state,
so the synthetic candidate's peak/steady VRAM metrics remain JSON `null`
(unmeasured), never numeric zero, and no `vram_sample` candidate event is emitted.
T2.1 does not load CUDA, run a
speech model, measure co-residency, or perform the 30-minute soak. Those checks
belong to candidate milestones. Every run README states these deviations. Seeing
the RTX 4090 in `nvidia-smi` proves metadata access only, not CUDA execution or
latency.

## T3.1 Nemotron 3.5 native streaming

The pinned runtime is `torch==2.12.1` (CUDA 13.0 wheel) and
`transformers==5.13.0`. The adapter uses the official `AutoProcessor`,
`AutoModelForRNNT`, and `TextIteratorStreamer` cache-aware path: one native
`generate` call consumes a lazy sequence of non-overlapping encoder chunks. It
does not repeatedly transcribe a growing recording. `nvcc` is not required.

Acquire and verify the model (weights remain ignored):

```sh
uv sync --frozen
uv run hf download nvidia/nemotron-3.5-asr-streaming-0.6b \
  model.safetensors config.json generation_config.json processor_config.json \
  tokenizer.json tokenizer_config.json \
  --revision 1c8deaecc64b91f034d73e08dd8b64625eb3395d \
  --local-dir models/nemotron-3.5-asr-streaming-0.6b
uv run python scripts/verify-models.py docs/model-manifest.json
uv run python - <<'PY'
import torch
assert torch.cuda.is_available()
print(torch.__version__, torch.version.cuda, torch.cuda.get_device_name(0))
PY
```

Acquire the ignored 55-item local corpus and verify every generated WAV:

```sh
uv run python scripts/acquire-librispeech-benchmark.py
uv run python -m benchmarks.harness verify \
  --dataset benchmarks/datasets/librispeech-t3.manifest.json
```

The corpus is derived from LibriSpeech test-clean under CC BY 4.0. It spans 35
speakers, plus ten deterministic low-noise and ten inserted-pause variants. It
covers read names/numbers where present, speaker variation, noise, and pauses;
it does **not** represent spontaneous podcast speech, broad conversational
accents, or room/microphone echo. Those are residual dataset gaps, not implied
coverage.

Run and validate the selected pinned 320 ms English configuration with real-time-paced 20 ms capture:

```sh
run_dir=$(uv run python -m benchmarks.harness run --kind stt \
  --candidate nemotron \
  --config benchmarks/configs/stt/nemotron-320ms.yaml \
  --dataset benchmarks/datasets/librispeech-t3.manifest.json | tail -1)
uv run python -m benchmarks.harness validate "$run_dir"
```

Run the continuous reset/stream soak with one model instance (this command lasts
at least 30 minutes and writes observed frame/chunk counts, drops, underruns,
reset generations, worker leaks, and capture-deadline lateness into
`summary.json.soak`). To keep this evidence run bounded, it performs one measured
preflight item before rotating the full 55-item corpus continuously during the
soak:

```sh
soak_dir=$(uv run python -m benchmarks.harness run --kind stt \
  --candidate nemotron \
  --config benchmarks/configs/stt/nemotron-320ms.yaml \
  --dataset benchmarks/datasets/librispeech-t3.manifest.json \
  --soak-minutes 30 | tail -1)
uv run python -m benchmarks.harness validate "$soak_dir"
```

Capture is paced against a monotonic clock in 20 ms frames. The shared RMS
VAD/endpointer emits measured speech-start and speech-end transitions; only the
terminal silence needed to close an otherwise active utterance and chunk-alignment
silence are appended. Thresholds are deterministic for matched-candidate replay
but are not calibrated against a live microphone. Latency fields use those actual
wall-clock transitions. RTF subtracts only measured adapter-side blocking on the
paced capture queue; producer sleep that overlaps GPU inference is retained. VRAM is
process-attributed using PyTorch's CUDA allocator peak/current counters;
`nvidia-smi` remains machine identity/ambient evidence only.

Nemotron's Transformers text streamer is explicitly frozen as
`append-only-rnnt-v1`: cumulative partials are observable, but this runtime did
not expose revising hypotheses, so revision/churn counts remain truthfully zero.
Summary WER/CER are conventional corpus micro rates (total edit errors divided by
total normalized reference words/characters); item records retain per-utterance
rates. Raw failures remain visible and no hosted inference fallback exists.

The soak's experimental pacing-conformance rule requires p95 20 ms capture-frame
deadline lateness at most 20 ms and maximum lateness at most 100 ms, in addition
to zero dropped frames, underruns, reset failures, and worker leaks. Each rotation
emits structured raw frame/chunk/reset/drop/leak/overrun counts and every capture
lateness sample; validation recomputes the soak aggregate from those iterations.
A continuity run that consumes every frame but misses this cadence is recorded as
failed, not silently treated as a pacing pass. The accepted T3.1 soak predates this
raw format and is admitted only by its exact run ID and four core artifact hashes.

## T3.2 Parakeet Unified buffered challenger

The canonical model is `nvidia/parakeet-unified-en-0.6b` at immutable revision
`fe53cd885760c96b6a5f51a0bfd362cb4584a98b`, under the NVIDIA Open Model License.
Its verified `.nemo` payload SHA-256 is
`ec23ed9150c8fde49072c3e2d61678ab903dbcef389d658db833420cbc1da35b`.
Acquire it exactly as recorded in `docs/model-manifest.json`.

NVIDIA's current model card names NeMo 2.7.3, but the published PyPI 2.7.3 runtime
cannot instantiate this pinned artifact (`att_chunk_context_size` is rejected).
The exercised runtime is therefore an explicit deviation: official NVIDIA NeMo Git
revision `58f3dd9250d4c9e0d3e865b78ccd5ea89dc420ba` (reported as
`3.1.0+58f3dd9250`) in an ignored, isolated `.venv-parakeet`. This preserves the
accepted Transformers 5.13 Nemotron environment; NeMo requires Transformers 4.57.
The local environment was created with:

```sh
uv venv .venv-parakeet --python 3.12
uv pip install --python .venv-parakeet/bin/python \
  'nemo_toolkit[asr]==2.7.3' 'torch==2.12.1+cu130' 'numba==0.63.1' \
  --extra-index-url https://download.pytorch.org/whl/cu130 \
  --index-strategy unsafe-best-match
uv pip install --python .venv-parakeet/bin/python --no-deps --reinstall \
  'nemo_toolkit @ git+https://github.com/NVIDIA-NeMo/NeMo.git@58f3dd9250d4c9e0d3e865b78ccd5ea89dc420ba'
uv pip install --python .venv-parakeet/bin/python jsonschema==4.25.1 rfc3339-validator==0.1.4
```

The adapter mirrors NVIDIA's stateful chunked RNNT algorithm. It recomputes the
explicit 5.6-second left context on every encoder call and retains only RNNT decoder
state. It is **buffered streaming, not cache-aware streaming**, and never repeatedly
decodes an entire growing recording. The capture seam supplies exact non-overlapping
20 ms packets so right-context boundaries do not wait for a future model-size packet.
Tracked official presets are 240 ms (80+160), 320 ms (80+240), and 560 ms (160+400),
where latency is model chunk plus right context. A terminal partial or empty flush
finalizes the buffered right context without delaying the preceding inference block.

Run a candidate with an explicit tracked config:

```sh
run_dir=$(TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD=1 .venv-parakeet/bin/python \
  -m benchmarks.harness run --kind stt --candidate parakeet \
  --config benchmarks/configs/stt/parakeet-320ms.yaml \
  --dataset benchmarks/datasets/librispeech-t3.manifest.json | tail -1)
uv run python -m benchmarks.harness validate "$run_dir"
```

Machine comparison fails closed unless the dataset, precision, language,
normalizer, VAD/endpointer, timing mode, raw capture chunk, raw left/right context,
and partial contract are equal. `algorithmicLatencyMs` is descriptive and does not
make unequal buffering semantics matched:

```sh
uv run python -m benchmarks.harness compare --runs <run-a> <run-b>
```

Consequently, official Nemotron native 320 ms (`320/0/0`) and Parakeet buffered
320 ms (`80/5600/240`) runs are intentionally reported as unmatched. The STT gate
cannot select from that comparison without new authority or an actually identical
supported context configuration.

The truthful paced 320 ms run does **not** currently meet the later STT selection
gate's p95 speech-start-to-first-partial target of 500 ms (observed about 1.25 s).
T3.1 establishes the candidate and measurements; it does not override or pre-pass
the post-challenger STT selection gate.

## T4.1 Kokoro ONNX baseline

### Frozen identity and isolated CPU runtime

The canonical model is `hexgrad/Kokoro-82M` at immutable revision
`f3ff3571791e39611d31c381e3a41a3af07b4987` (Apache-2.0). The maintained ONNX
runtime is `thewh1teagle/kokoro-onnx` at commit
`98ea02a5692534c2ba496708e2f19de25028412b` (package version 0.5.0, MIT). Model
assets come from its `model-files-v1.0` tag at commit
`6843c53fc280ab130b7a8d206ebd3407e094efdc`. That release publishes no upstream
checksums, so acquisition records and verifies these locally computed SHA-256 values:

- `kokoro-v1.0.onnx`: `7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5`
- `voices-v1.0.bin`: `bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d`

The frozen voice is the supported American English `af_heart` stock voice. Output is
native 24 kHz signed little-endian PCM16 mono. The provider is intentionally
`CPUExecutionProvider`; no Kokoro GPU acceleration or candidate VRAM usage is claimed.
The primary Nemotron environment remains unchanged. Kokoro runs in ignored
`.venv-kokoro`, recreated from the tracked, hash-pinned
`services/audio/kokoro-requirements.lock`:

```sh
uv venv .venv-kokoro --python 3.12
uv pip sync --python .venv-kokoro/bin/python services/audio/kokoro-requirements.lock
uv run python scripts/acquire-kokoro.py
uv run python scripts/verify-models.py docs/model-manifest.json
```

The runtime freeze was checked against the pinned repository README, source
`create_stream` implementation, provider example, PyPI 0.5.0 metadata, Git tag/commit,
and canonical model voice/license documentation. `create_stream` generates
sentence/phoneme batches on background inference. The adapter owns that work behind
named bounded workers, rechunks accepted output to 20 ms PCM frames, suppresses all
post-cutoff audio, and poisons reuse if a worker misses its bounded join.

### Comparison and timing contract

`benchmarks/datasets/tts-prompts-v1.manifest.json` contains 24 exact, individually
SHA-256-committed English prompts. It covers acknowledgements, podcast responses,
names, numbers, dates, abbreviations, punctuation, questions, emphasis, and difficult
phonemes. Candidate-specific text rewriting is forbidden. Comparison fails closed
unless prompt ID/hash, language, native/comparison sample rate, PCM format/channels,
20 ms adapter chunking, fixed gain 0.9, speed 1.0, no-resampler policy, monotonic timing
mode, and listening version match. Candidate/model/runtime/voice/provider identity is
kept outside shared semantics and remains private only during listening.

TTFA starts immediately before synthesis and ends on the first accepted non-empty PCM
chunk. RTF is adapter synthesis processing seconds divided by generated audio seconds.
Each passed item retains exact prompt hash, WAV path, PCM checksum, samples, duration,
processing time, chunk count, RSS, and request/first-audio/final events. The validator
reopens every WAV, checks its canonical header and signed PCM payload, recomputes its
PCM checksum/duration and aggregate summary, and resolves the prompt hash to exactly
one tracked manifest. Gain is fixed across candidates; there is no per-item loudness
normalization. Any sample that would clip after gain, any non-finite output, malformed
PCM, empty output, or sample-rate mismatch fails.

Run and validate the full baseline:

```sh
run_dir=$(.venv-kokoro/bin/python -m benchmarks.harness run --kind tts \
  --candidate kokoro --config benchmarks/configs/tts/kokoro.yaml \
  --prompts benchmarks/datasets/tts-prompts-v1.manifest.json | tail -1)
uv run python -m benchmarks.harness validate "$run_dir"
```

Run the real cancellation-after-first-audio probe. Its JSON names every checked and
surviving owned worker and reports accepted chunks at the cutoff:

```sh
.venv-kokoro/bin/python -m benchmarks.harness probe-cancel --candidate kokoro \
  --config benchmarks/configs/tts/kokoro.yaml \
  --prompts benchmarks/datasets/tts-prompts-v1.manifest.json
```

Run the required playback-paced soak. It uses one fresh model instance, rotates all 24
prompts, resets between prompts, feeds a bounded queue, and consumes each PCM chunk at
24 kHz wall-clock playback pace. Raw per-iteration samples/chunks, deadline lateness,
drops, resets, underruns, and worker leaks are independently recomputed by validation:

```sh
soak_dir=$(.venv-kokoro/bin/python -m benchmarks.harness run --kind tts \
  --candidate kokoro --config benchmarks/configs/tts/kokoro.yaml \
  --prompts benchmarks/datasets/tts-prompts-v1.manifest.json \
  --soak-minutes 30 | tail -1)
uv run python -m benchmarks.harness validate "$soak_dir"
```

Create the single-candidate blinded baseline package without revealing it:

```sh
uv run python -m benchmarks.harness listen --runs "$run_dir" \
  --assessor t4.1-baseline --attempt 1
```

The generated `listening.json` and `listening-media/` use only opaque prompt/sample
labels. Candidate identity remains in the mode-0600 private mapping outside the public
projection. Do not run `reveal` for this baseline. A later Qwen paired comparison will create a fresh package over matched Kokoro
and Qwen runs.

## T4.2 Qwen3-TTS CustomVoice harness admission

The admitted Qwen candidate is `qwen3-0.6b`, the official
`Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice` snapshot at immutable revision
`85e237c12c027371202489a0ec509ded67b5e4b5`. Its benchmark config binds the
faster-Qwen streaming runtime, lockfile, CUDA device, bfloat16 precision, `Ryan`
voice, and every model asset hash recorded in `docs/model-manifest.json`. The
harness verifies the selected model and all attested files before preparing the
adapter; it does not accept a config or model path that merely has the right
primary filename.

Qwen uses the same 24-prompt `tts-prompts-v1` manifest and exact 20-ms, 24-kHz
PCM16 mono comparison contract as Kokoro. The model API language label `English`
is normalized only for this shared manifest's `en-us` locale; source text is
never rewritten. TTFA is request to the first accepted non-empty 20-ms chunk,
RTF is the monotonic harness request-to-completion window divided by generated
audio duration, and RSS is sampled over the whole synthesis window. Candidate
runtime, voice, provider, and model identity remain outside shared listening
semantics. The isolated Qwen lock intentionally contains the model runtime only;
install the pinned faster-Qwen checkout and the small harness validation closure
into that environment without changing the recorded Qwen lock:

```sh
uv pip install --python /tmp/qwen-env/bin/python --no-deps \
  -e /tmp/faster-qwen3-tts
uv pip install --python /tmp/qwen-env/bin/python \
  'jsonschema==4.25.1' 'rfc3339-validator==0.1.4'
```

Run and validate one candidate before comparison:

```sh
run_dir=$(/tmp/qwen-env/bin/python -m benchmarks.harness run --kind tts \
  --candidate qwen3-0.6b \
  --config benchmarks/configs/tts/qwen3-0.6b.yaml \
  --prompts benchmarks/datasets/tts-prompts-v1.manifest.json | tail -1)
uv run python -m benchmarks.harness validate "$run_dir"
```

Run the cancellation-after-first-audio probe against the validated run. It
requires the local cancellation cutoff to be honored, records the accepted
chunk/sample boundary, checks Qwen-owned workers before and after close, and
fails closed on a mismatched run/config/model/prompt identity:

```sh
/tmp/qwen-env/bin/python -m benchmarks.harness probe-cancel \
  --candidate qwen3-0.6b \
  --config benchmarks/configs/tts/qwen3-0.6b.yaml \
  --prompts benchmarks/datasets/tts-prompts-v1.manifest.json \
  --run "$run_dir"
```

The bounded playback-paced soak uses the same raw per-iteration telemetry as
Kokoro. For the Qwen reliability gate, run the five-minute override, then
validate the artifact. Validation recomputes sample/chunk continuity, reset
counts, underrun episodes, missed samples, deadline lateness, severe failures,
and worker cleanup from raw events rather than trusting the submitted summary:

```sh
soak_dir=$(/tmp/qwen-env/bin/python -m benchmarks.harness run --kind tts \
  --candidate qwen3-0.6b \
  --config benchmarks/configs/tts/qwen3-0.6b.yaml \
  --prompts benchmarks/datasets/tts-prompts-v1.manifest.json \
  --soak-minutes 5 | tail -1)
uv run python -m benchmarks.harness validate "$soak_dir"
```

Create the assessor-safe single-candidate projection, or the paired blinded
comparison once a matched Kokoro run is available:

```sh
uv run python -m benchmarks.harness listen --runs "$run_dir" \
  --assessor qwen-t4.2 --attempt 1
uv run python -m benchmarks.harness listen --runs "$kokoro_run" "$run_dir" \
  --assessor qwen-paired --attempt 1
```

The projection exposes only opaque prompt/sample labels and copied audio paths.
Candidate identity, machine metrics, seed, and the committed mapping stay
hidden until a paired rating submission is locked. `compare` and
`prepare_listening_runs` refuse mismatched prompt hashes, source sets, shared
semantics, repetitions, or terminal statuses. A single-candidate projection is
not rateable; it is evidence that the admitted candidate run is valid, not a
selection result.

## T4.3 faster-Qwen Base voice-clone spike

The evaluation-only Base candidate is the official
`Qwen/Qwen3-TTS-12Hz-0.6B-Base` snapshot at immutable revision
`5d83992436eae1d760afd27aff78a71d676296fc` under Apache-2.0. All 13 snapshot file
hashes are recorded in `docs/model-manifest.json` and acquired with:

```sh
uv run python scripts/acquire-qwen3-tts-base.py
uv run python scripts/verify-models.py docs/model-manifest.json
```

The Torch backend is `andimarafioti/faster-qwen3-tts` at commit
`a70afc0f81f7f5f8801c3227968f1102f43f211c` (MIT), using the isolated
`services/audio/qwen-requirements.lock` environment: Python 3.12, Torch
2.12.1+cu130, Transformers 4.57.3, eager attention, and bfloat16. The optional
GGML/qwentts.cpp backend, `franken_tts`, and any hosted fallback are excluded.

The reference is `item-005-clean.wav` from the tracked LibriSpeech test-clean
manifest: CC BY 4.0, source archive SHA-256
`39fde525e59672dc6d1551919b1478f724438a95aa55f874b576be21967e6c23`, recording
SHA-256 `3690ab91ce574f4becf1b03ff9d03bdc2e3f674dcef6b21d7c87ebae2199c6e8`, and
its committed transcript. The runner records the exact source, license,
transcript, recording format, and effective ICL reference after the wrapper's
0.5-second trailing silence.

Run the standalone evidence capture on the WSL RTX 4090:

```sh
run_dir=$(date -u +%Y%m%dT%H%M%SZ)
/tmp/qwen-env/bin/python scripts/faster-qwen3-tts-base-clone-spike.py \
  --faster-repo /tmp/faster-qwen3-tts \
  --output-dir "benchmarks/results/faster-qwen3-tts-base-clone-$run_dir"
```

The runner verifies model and reference provenance before model load, measures
one-time x-vector/ICL prompt extraction, CPU serialization and device transfer,
uncached and cached path prompts, serialized prompts, repeated requests, buffered
and true chunked streaming, native chunk duration, first packet/TTFA, total
processing, both RTF directions, signed PCM16LE/WAV validity, process-attributed
VRAM/RSS peaks, and exact failures. Its bounded queue probe starts a simulated
24-kHz playback consumer and requires at least 10 seconds of generated audio with
zero dropped packets and zero underruns. Native packets are not the project's
20-ms transport frames; an eventual adapter must rechunk them.

The accepted spike artifact and full comparison are documented in
`artifacts/evidence/2026-08-16-faster-qwen3-tts-base-voice-clone.md`. Kokoro CUDA
remains the production fallback and this spike does not authorize replacing the
official Qwen dependency.
