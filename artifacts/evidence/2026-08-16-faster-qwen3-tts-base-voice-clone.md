# Task hy1: faster-Qwen Base voice-clone performance

**Date:** 2026-08-16  
**Machine:** WSL2, NVIDIA GeForce RTX 4090  
**Result:** **Pinned official Base voice cloning runs. Warm x-vector and full ICL streaming are faster than realtime, and a bounded queue plays a 12.8-second response with zero underruns. Keep Kokoro as production fallback.**

## Scope and decision

This spike tests recording-based voice cloning with the official
`Qwen/Qwen3-TTS-12Hz-0.6B-Base` model through the Torch backend of
`andimarafioti/faster-qwen3-tts`. It does not replace the official Qwen runtime,
add a production adapter, use the optional GGML/qwentts.cpp backend, use
`franken_tts`, or change the selected Kokoro fallback.

The accepted artifact is retained at:

```text
benchmarks/results/faster-qwen3-tts-base-clone-20260816T091000Z/
```

It contains `result.json`, `console.log`, prompt cache files, and validated
PCM/WAV outputs. The result directory is ignored by the repository payload rules.
The runner and this evidence are tracked.

The accepted `result.json` SHA-256 is
`b492628dc0eac22ad22987dc739a0ee587222ea7613a9e0ec7e601134e666f82`. The runner
script SHA-256 is
`79da98462c1a111af1a8da3800d3a66c63f7821806ec65e010a99166c14fb747`. The run
used `--ttfa-repetitions 1 --queue-capacity 4`.

The pinned runtime had no compatibility deviation. The Base model loaded as a
Base model, both x-vector and full ICL prompts worked, true chunked streaming
worked, and all required observations passed. This is feasibility evidence, not
a voice-quality or production-selection decision. Kokoro remains the production
fallback.

## Source, model, license, and reference identity

| Field | Observed value |
|---|---|
| faster repository | `https://github.com/andimarafioti/faster-qwen3-tts.git` |
| faster commit / package | `a70afc0f81f7f5f8801c3227968f1102f43f211c` / `0.3.2` (`v0.3.2`) |
| faster license | MIT; `LICENSE` SHA-256 `442472a518bf71e371f2581aa0fcaf6ee2ef6854f78c340fdbe87c099950ea82` |
| Qwen model | `Qwen/Qwen3-TTS-12Hz-0.6B-Base` |
| Qwen revision | `5d83992436eae1d760afd27aff78a71d676296fc` |
| Qwen model license | Apache-2.0 |
| Qwen model SHA-256 | `180b3b10eb1c9f1b4db7806d5475bae3071c0243c299d49926bab1da3b6946f6` |
| Qwen model manifest | `docs/model-manifest.json`, run hash `c0d064d0f88bbce2b70cee67ab2e8a2e1df02bd40ed0837a06119c841667360f` |
| Qwen runtime lock | `services/audio/qwen-requirements.lock`, SHA-256 `1855d1a144fdde4fb026a16302e73203d832fccae8155a6f77d40196d40142ab` |
| Reference corpus | LibriSpeech test-clean, CC BY 4.0 |
| Reference source/archive | `https://www.openslr.org/resources/12/test-clean.tar.gz`; archive SHA-256 `39fde525e59672dc6d1551919b1478f724438a95aa55f874b576be21967e6c23` |
| Reference recording | `item-005-clean.wav`, source ID `1284-1180-0000-clean`, 8.12 s, 16 kHz mono PCM16LE |
| Reference recording SHA-256 | `3690ab91ce574f4becf1b03ff9d03bdc2e3f674dcef6b21d7c87ebae2199c6e8` |
| Reference transcript | `HE WORE BLUE SILK STOCKINGS BLUE KNEE PANTS WITH GOLD BUCKLES A BLUE RUFFLED WAIST AND A JACKET OF BRIGHT BLUE BRAIDED WITH GOLD` |

The model and reference manifests were verified before model load. The model
snapshot was acquired with `scripts/acquire-qwen3-tts-base.py`; its 13 file
hashes are recorded in the model manifest. The runner recorded both the original
reference hash and the effective ICL input: the 8.12-second recording plus the
wrapper's documented 0.5-second trailing silence, for 8.62 seconds total.

## Runtime and hardware

| Field | Observed value |
|---|---|
| Python | `3.12.11` |
| PyTorch | `2.12.1+cu130` |
| PyTorch CUDA | `13.0` |
| cuDNN | `92000` |
| `qwen-tts` | `0.1.1` |
| Transformers / Accelerate | `4.57.3` / `1.12.0` |
| NumPy / soundfile | `2.5.2` / `0.14.0` |
| Platform / kernel | Linux WSL2 / `6.6.114.1-microsoft-standard-WSL2` |
| GPU / capability | GeForce RTX 4090 / `sm_89` |
| Driver | `610.47` |
| Dtype / attention | bfloat16 / eager |
| Model preparation | 1.313 s; process start to ready 6.620 s |

Peak VRAM below is process-attributed through the PyTorch allocator. The
`nvidia-smi` readings are whole-device ambient context and are not used as the
candidate peak.

## Prompt extraction and serialization

Prompt extraction was measured through the official Qwen prompt API before
passing a prompt to faster-qwen. The cache files are CPU-safe `torch.save` envelopes containing a prompt and
binding metadata for the model revision, reference hash, faster-qwen commit, and
runtime lock. Load and device-transfer were measured and tensor signatures were
round-tripped.

| Prompt | Extraction | Main tensors | Serialized file | Save / load / CUDA transfer |
|---|---:|---|---:|---:|
| x-vector | 1.403 s | speaker embedding `[1024]`, bfloat16, 2,048 bytes | 4,314 bytes | 1.16 / 0.57 / 0.17 ms |
| Full ICL | 78.2 ms | ref codes `[108,16]`, int64, 13,824 bytes; speaker embedding `[1024]`, bfloat16 | 18,365 bytes | 0.32 / 0.38 / 0.13 ms |

The x-vector prompt tensor SHA-256 is
`2a0ca1b2e579a6190c13d8f9e7a2afc6eda406a1cb7cdb1ba6eb98ac2b96dfef`.
The ICL ref-code tensor SHA-256 is
`61fa050896dfa93c2ce0419a4900abf50105aeec587b3188102c8acbdbe0c6ea`.
The serialized prompt file hashes are:

- x-vector: `4a0b5d6d39c154988355cdbff3d291e27584eb2bd9b805c5be8506f6923f1017`
- ICL: `9ac61b35f433fb792e4cb1c4ca7a70e9ee15f2380b914f71ea25af5afaed3805`

The apparent difference between x-vector and ICL extraction time is retained as
observed. The x-vector extraction ran first and includes the first lazy speaker
encoder work; the ICL extraction reused the initialized model components. It is
not normalized away.

## Streaming and audio validity

**True chunked streaming: yes.** With `chunk_size=8`, each required streaming
observation yielded 20 non-empty native packets before the generator completed.
The first packet arrived before completion, not as a post-hoc split of a complete
waveform. Native packets contain 15,360 samples, or 640 ms at 24 kHz. The
observed decoder rate is 1,920 samples per codec step, or 12.5 codec frames per
second. These are not the project's 20 ms transport frames; a future adapter
would need to rechunk them into 480-sample packets.

The serialized x-vector streaming output used for the packet and PCM checks was
307,200 samples, 12.8 seconds, and 614,400 PCM bytes:

- signed PCM16LE, mono, 24,000 Hz;
- finite non-empty float output within the PCM range before conversion;
- WAV reopened with matching header and payload;
- PCM SHA-256 `f5076ff20a93e01f4085cfaaa2e42eee3e5697683193eb7a1b5f9f63b50cb1ed`;
- WAV SHA-256 `d1f9b56249b8890d9616b46062394626bc4d2bd352370f823e86717e09f640c0`.

The ICL serialized stream also produced 12.8 seconds and passed the same PCM
checks. All native packet PCM hashes and all output WAV checks are retained in
`result.json`.

## Timing results

Project RTF means **processing seconds / generated audio seconds**, matching
QW-2. Values below 1.0 are faster than realtime. The reciprocal is also shown
as generated audio seconds / processing seconds.

| Observation | First audio | Total processing | Audio | Project RTF | Reciprocal |
|---|---:|---:|---:|---:|---:|
| x-vector, uncached reference path | 7.698 s | 11.180 s | 12.8 s | 0.873 | 1.145x |
| x-vector, cached reference path | 280.3 ms | 3.622 s | 12.8 s | 0.283 | 3.534x |
| x-vector, serialized prompt | 262.4 ms | 3.436 s | 12.8 s | 0.268 | 3.725x |
| x-vector, repeated serialized request 1 | 260.6 ms | 3.564 s | 12.8 s | 0.278 | 3.592x |
| x-vector, repeated serialized request 2 | 261.0 ms | 3.438 s | 12.8 s | 0.269 | 3.723x |
| ICL, uncached reference path | 353.6 ms | 3.622 s | 12.8 s | 0.283 | 3.534x |
| ICL, cached reference path | 270.6 ms | 3.513 s | 12.8 s | 0.274 | 3.644x |
| ICL, serialized prompt | 281.2 ms | 3.525 s | 12.8 s | 0.275 | 3.631x |
| x-vector, buffered serialized | full return at 2.811 s | 2.811 s | 12.8 s | 0.220 | 4.554x |
| ICL, buffered serialized | full return at 2.817 s | 2.817 s | 12.8 s | 0.220 | 4.544x |

The uncached x-vector request includes prompt extraction in the request-to-first
audio boundary. The cached path reuses faster-qwen's in-process reference
prompt cache. The serialized path proves the binding-checked cache artifact
can skip extraction in this process. It is not a fresh-process portability test.
Full ICL is supported and uses the reference transcript plus
reference codec tokens. Buffered rows are not streaming and are included only as
throughput context.

The serialized x-vector TTFA sweep used one run per native packet size in this
bounded evidence capture:

| Codec steps per native packet | Native first packet | TTFA |
|---:|---:|---:|
| 1 | 80 ms | 167.7 ms |
| 4 | 320 ms | 220.5 ms |
| 8 | 640 ms | 266.7 ms |

The repeated-request observations are the same voice prompt and the same fixed
seed/configuration. Sampling outputs are not claimed to be bit-identical across
separate process runs.

## Queue-backed realtime playback

The queue probe used the serialized x-vector prompt, a bounded queue of four
native packets, a producer consuming the pull-based faster-qwen generator, and a
consumer sleeping at the native 24 kHz playback duration for each packet. It
produced and consumed a 12.8-second response, which exceeds the requested
10-second check.

| Queue metric | Observed |
|---|---:|
| Producer wall time | 9.868 s |
| Generator processing time | 3.594 s |
| Queue enqueue backpressure | 6.270 s |
| Playback wall time | 13.068 s |
| Playback start delay / first packet | 264.9 ms / 640 ms audio |
| Queue high-water / capacity | 4 / 4 native packets |
| Queue min / max audio ahead | 640 ms / 3.2 s |
| Produced / consumed packets and samples | 20 / 20; 307,200 / 307,200 |
| Underruns / underrun time | 0 / 0 s |
| Dropped packets | 0 |
| Playback deadline p95 / maximum lateness | 2.642 / 2.753 ms |
| Generator RTF / reciprocal | 0.281 / 3.561x |
| Realtime conformance | **pass** |

The queue stayed ahead for the complete 12.8-second playback. Generator time,
producer wall time, enqueue backpressure, and playback wall time are separate,
so the queue row's RTF is not confused with the direct streaming rows. The
producer and consumer packet/sample counts matched. This is a bounded
synthetic playback clock, not an audio-device or integrated browser test.

## Resource results

Whole-process peaks from the accepted run:

- Peak VRAM reserved: **3,670,016,000 bytes** (`3.418 GiB`), source
  `torch.cuda.max_memory_reserved()` across preparation, prompt extraction,
  synthesis, TTFA, and queue phases.
- Peak VRAM allocated: **2,946,592,256 bytes** (`2.744 GiB`).
- Peak RSS: **2,678,288,384 bytes** (`2.495 GiB`), maximum of the 10 ms
  `/proc/self/status` sampler and Linux `RUSAGE_SELF.ru_maxrss`.

The 3.67 GB reserved peak occurred during the buffered ICL phase and was
retained by the CUDA allocator for later phases. It is a process-attributed
allocator peak, not an ambient `nvidia-smi` number.

## Failures and deviations

- **Pinned Base model and runtime:** passed. All 13 model files and the
  LibriSpeech reference hash passed before model load. CUDA was available and
  the device was `sm_89`.
- **Prompt modes:** passed. X-vector and full ICL prompt extraction,
  serialization, cached paths, and generation all worked.
- **Streaming:** passed. All required streaming observations yielded multiple
  packets before completion and passed 24 kHz PCM validation.
- **Queue gate:** passed. The 12.8-second bounded playback had zero underruns,
  zero drops, matching produced/consumed packet and sample counts, and only
  measured scheduler lateness of 2.753 ms maximum.
- **Recorded failures:** none. `result.json` has an empty `failures` array and
  `compatibility.failureCount` is `0`.
- **Warnings:** the environment printed the existing optional-SoX warning from
  qwen-tts because `sox` is not installed. The warning did not affect the local
  WAV, PCM, or model run.
- **Not tested here:** cancellation after first packet, 20 ms transport
  rechunking, co-resident Nemotron serving, integrated audio hardware, and
  listening-quality ratings. These remain adapter or selection work, not hidden
  claims of this spike.

## Comparison with existing evidence

| Candidate / mode | Streaming first audio | Complete or streaming processing | Audio | Project RTF |
|---|---:|---:|---:|---:|
| Base x-vector, cached path | 280.3 ms; 640 ms native packet | 3.622 s | 12.8 s | 0.283 |
| Base full ICL, cached path | 270.6 ms; 640 ms native packet | 3.513 s | 12.8 s | 0.274 |
| 9mm faster-Qwen CustomVoice, warm chunk 8 | 264.4 ms sweep mean; 640 ms packet | 2.112 s | 7.76 s | 0.272 |
| Official QW-2 CustomVoice, warm | full return at 27.874 s | 27.874 s | 8.88 s | 3.139 |
| Official QW-2 CustomVoice, cold | full return at 29.584 s | 29.584 s | 8.88 s | 3.332 |
| Kokoro CUDA technical-01 evidence | 279.8 ms | 312.0 ms | not retained in that comparison row | not restated |

The Base clone timings are close to the 9mm CustomVoice faster path at the same
native chunk size, while the Base run reserves more VRAM: 3.670 GB versus
2.779 GB in the 9mm artifact. Base peak RSS was 2.679 GB versus 2.657 GB in the
9mm artifact. These are separate processes and ambient conditions, so they are
not a co-resident resource claim. QW-2 is the official complete-waveform path,
so its first-audio boundary is necessarily full return and is not a matched
streaming comparison. Kokoro's prior CUDA number remains the production
baseline and was not rerun in this task.

## Decision

The official Base model plus the pinned faster Torch backend is **feasible for
local recording-based voice-clone evaluation** on the WSL RTX 4090. It supports
both x-vector and full ICL prompts, cache serialization, true native chunked
output, valid 24 kHz PCM16LE, and a bounded queue that stayed ahead of realtime
playback for 12.8 seconds.

This does **not** select Qwen for production. Keep Kokoro as the production
fallback. Do not use `franken_tts` and do not replace the official Qwen
dependency without a separate license, provenance, reproducibility, adapter
reliability, and listening-quality review.
