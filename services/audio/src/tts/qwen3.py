from __future__ import annotations

import base64
import csv
import hashlib
import importlib.metadata
import importlib.util
import io
import json
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from pathlib import Path
import queue
import threading
import time
from typing import Any, Protocol

from .base import AudioCallback, AudioChunk, Cancellation, MAX_VOICE_TONE_PROMPT_BYTES, SynthesisResult, speed_capability
from .kokoro import segment_text, validate_text
from ..voice_enrollment import (
    CUSTOM_VOICE_SAMPLE_RATE,
    MAX_CUSTOM_VOICES,
    decode_reference,
    validate_name,
    validate_voice_id,
)

CANDIDATE_ID = "qwen3-1.7b"
MODEL_ID = "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice"
MODEL_REVISION = "6c3e96b6a2c593ce3e546ee699a5d944de81850e"
MODEL_SHA256 = "38b1d5971bdbd982b561cccec982669a53b0537c3cf5e9bd4778ed07bb2f5137"
# User-enrolled voices are synthesized through the pinned Base voice-cloning
# route (decision 008). The CustomVoice model stays authoritative for stock
# speakers; the Base model is never used to fake a stock voice.
BASE_MODEL_ID = "Qwen/Qwen3-TTS-12Hz-0.6B-Base"
BASE_MODEL_REVISION = "5d83992436eae1d760afd27aff78a71d676296fc"
BASE_MODEL_SHA256 = "180b3b10eb1c9f1b4db7806d5475bae3071c0243c299d49926bab1da3b6946f6"
BASE_TTS_CONFIG_ID = "qwen3-tts-0.6b-base-clone-cuda-v1"
FASTER_REPO_URL = "https://github.com/andimarafioti/faster-qwen3-tts.git"
FASTER_REPO_COMMIT = "a70afc0f81f7f5f8801c3227968f1102f43f211c"
FASTER_RUNTIME_REVISION = FASTER_REPO_COMMIT
RUNTIME_REVISION = FASTER_RUNTIME_REVISION
FASTER_RUNTIME_VERSION = "0.3.2"
RUNTIME_VERSION = FASTER_RUNTIME_VERSION
FASTER_LICENSE_SHA256 = "442472a518bf71e371f2581aa0fcaf6ee2ef6854f78c340fdbe87c099950ea82"
FASTER_PACKAGE_FILES: tuple[tuple[str, str], ...] = (
    ("__init__.py", "f6f09484a9fb77e68e8bcb9ccd079d7cbfc1db2c7584b55674f759dbc5486252"),
    ("cli.py", "4ebcdd4f3c7f4b362aab7e252cfd38b1f169b170511fd5966855775549ba6b27"),
    ("generate.py", "972d167ff41cb10593fe5dcfa9a4fd07d7a0ec680e86d86b9fd394bf2280c35f"),
    ("ggml_backend.py", "34f7c4f34df00db8b312f4d73f81e93afeeebe00d0735b23c4f4901c362cadbd"),
    ("model.py", "8ffa4f39708c4d22e6707323cf102d128eff05595fe2229919cdb495fef612dc"),
    ("predictor_graph.py", "9f74155040fb6ac2381375331f76fb4efcd5b3c0761ebfc4977717223145cb76"),
    ("sampling.py", "d52f136cb5d985f532239cb3f74ce5e8b9bfd269080e99295f09ce5f87bac988"),
    ("streaming.py", "39a1420626c49b87f3cda486f5a3f0fb8a82238f9a052114970ada40d1959010"),
    ("talker_graph.py", "2e402ef29d80b076481ab55dc6d20f1c55cae56604b5c3540c24a13f674b3d73"),
    ("utils.py", "58b3bd9cfaa2eb7c054adfcff1116159f858e9932f79f29d0a3aa01503c9430e"),
)
QWEN_REQUIREMENTS_LOCK_SHA256 = "1855d1a144fdde4fb026a16302e73203d832fccae8155a6f77d40196d40142ab"
RUNTIME_LOCK_SHA256 = QWEN_REQUIREMENTS_LOCK_SHA256
QWEN_LOCK_SHA256 = QWEN_REQUIREMENTS_LOCK_SHA256
RUNTIME_PACKAGES: tuple[tuple[str, str], ...] = (
    ("qwen-tts", "qwen_tts"),
    ("transformers", "transformers"),
    ("accelerate", "accelerate"),
    ("torch", "torch"),
)

# The official runtime remains part of the provenance record.  The adapter uses
# the faster wrapper around that runtime, never the wrapper's buffered API.
OFFICIAL_RUNTIME_CONTRACT = (
    "qwen-tts==0.1.1; transformers==4.57.3; accelerate==1.12.0; "
    "torch==2.12.1+cu130 (CUDA 13.0); dtype=torch.bfloat16; "
    "attn_implementation=eager"
)
RUNTIME_CONTRACT = (
    f"faster-qwen3-tts=={FASTER_RUNTIME_VERSION}; git={FASTER_REPO_COMMIT}; "
    f"{OFFICIAL_RUNTIME_CONTRACT}"
)

ROOT = Path(__file__).resolve().parents[4]
MODEL_PATH = (ROOT / "models/qwen3-tts-12hz-1.7b-customvoice").resolve()
BASE_MODEL_PATH = (ROOT / "models/qwen3-tts-12hz-0.6b-base").resolve()
QWEN_REQUIREMENTS_PATH = (ROOT / "services/audio/qwen-requirements.lock").resolve()
SAMPLE_RATE = 24_000
SPEAKER = "Ryan"
VOICE = SPEAKER
LANGUAGE = "English"
PROVIDER = "CUDA"
DEVICE = "cuda"
MANIFEST_DEVICE = "cuda:0"
PRECISION = "bfloat16"
DTYPE = PRECISION
ATTENTION = "eager"
ATTN_IMPLEMENTATION = ATTENTION
BACKEND = "torch-cuda-graph"
CHUNK_SIZE_CODEC_STEPS = 8
CHUNK_SIZE = CHUNK_SIZE_CODEC_STEPS
MAX_NEW_TOKENS = 2_048
MIN_NEW_TOKENS = 2
TEMPERATURE = 0.9
TOP_K = 50
TOP_P = 1.0
DO_SAMPLE = True
REPETITION_PENALTY = 1.05
OUTPUT_FORMAT = "pcm_s16le_mono"
MAX_TEXT_CHARACTERS = 4_000
CHUNK_SAMPLES = SAMPLE_RATE * 20 // 1000
TTS_CONFIG_ID = "qwen3-tts-1.7b-customvoice-cuda-v1"

# These names and hashes are the complete immutable Base snapshot acquired by
# scripts/acquire-qwen3-tts-base.py and attested in artifacts/evidence
# 2026-08-16-faster-qwen3-tts-base-voice-clone.md. Checking every file prevents
# a valid primary safetensors file from being paired with a different
# tokenizer or speech codec.
BASE_MODEL_ASSETS: tuple[tuple[str, str], ...] = (
    (".gitattributes", "11ad7efa24975ee4b0c3c3a38ed18737f0658a5f75a0a96787b576a78a023361"),
    ("README.md", "181187b6057906bd960bc7f938d0b7a16652509776a0d52c4885b4ae5ccda0ea"),
    ("config.json", "2e714c787c8edb98b05432685cddb634add2de4d4e645f653d68251ef72ba011"),
    ("generation_config.json", "f1b90b4513f3b34c62851049e2492d7b4c5940daf1276f89c82b8ef04127f3aa"),
    ("merges.txt", "599bab54075088774b1733fde865d5bd747cbcc7a547c5bc12610e874e26f5e3"),
    ("model.safetensors", BASE_MODEL_SHA256),
    ("preprocessor_config.json", "efdde1022ea9d76928bf7a9cd53139138f5ba2e466e837f08f6105ab1af1c119"),
    (
        "speech_tokenizer/config.json",
        "ee65bb901c876664ab8707c487157aa1a6ee57c65969b28fb5ec9dc211e68167",
    ),
    (
        "speech_tokenizer/configuration.json",
        "6bc26d64eb5024b4d1dab5a52371958b429256d6c9d59787f1f5294a54e0cebd",
    ),
    (
        "speech_tokenizer/model.safetensors",
        "836b7b357f5ea43e889936a3709af68dfe3751881acefe4ecf0dbd30ba571258",
    ),
    (
        "speech_tokenizer/preprocessor_config.json",
        "fcb3805e597e786d4067706e602f6688524640f8d3396790e2e09b5942fcbdfb",
    ),
    ("tokenizer_config.json", "dc3c31c3bdaedd5016382bb3cbe07323026775ad51f5a4fb564505992ae4a670"),
    ("vocab.json", "ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910"),
)

MODEL_ASSETS: tuple[tuple[str, str], ...] = (
    (".gitattributes", "11ad7efa24975ee4b0c3c3a38ed18737f0658a5f75a0a96787b576a78a023361"),
    ("README.md", "4bcf87ecfbbb8e07a01b21415a970c8b53a5283bf6872b657040d3f45c9241f7"),
    ("config.json", "17a07f527a1c25ea30b4e023a184482a23d3e279d697b1dc81b1bde498d29cf9"),
    ("generation_config.json", "f1b90b4513f3b34c62851049e2492d7b4c5940daf1276f89c82b8ef04127f3aa"),
    ("merges.txt", "599bab54075088774b1733fde865d5bd747cbcc7a547c5bc12610e874e26f5e3"),
    ("model.safetensors", MODEL_SHA256),
    ("preprocessor_config.json", "efdde1022ea9d76928bf7a9cd53139138f5ba2e466e837f08f6105ab1af1c119"),
    (
        "speech_tokenizer/config.json",
        "ee65bb901c876664ab8707c487157aa1a6ee57c65969b28fb5ec9dc211e68167",
    ),
    (
        "speech_tokenizer/configuration.json",
        "6bc26d64eb5024b4d1dab5a52371958b429256d6c9d59787f1f5294a54e0cebd",
    ),
    (
        "speech_tokenizer/model.safetensors",
        "836b7b357f5ea43e889936a3709af68dfe3751881acefe4ecf0dbd30ba571258",
    ),
    (
        "speech_tokenizer/preprocessor_config.json",
        "fcb3805e597e786d4067706e602f6688524640f8d3396790e2e09b5942fcbdfb",
    ),
    ("tokenizer_config.json", "dc3c31c3bdaedd5016382bb3cbe07323026775ad51f5a4fb564505992ae4a670"),
    ("vocab.json", "ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910"),
)

# The adapter itself owns only these threads.  The faster runtime's CUDA graph
# execution is synchronous on the inference worker and is never delegated to a
# subprocess or an untracked process pool.
OWNED_THREAD_PREFIXES = ("qwen-inference", "qwen-output", "qwen-runtime-executor")


class QwenBackend(Protocol):
    poisoned: bool

    def prepare(
        self, model_path: str, device: str, dtype: str, attn_implementation: str
    ) -> None: ...

    def get_voices(self) -> list[str]: ...

    def create_stream(
        self, text: str, speaker: str, language: str, tone_prompt: str | None = None
    ) -> Iterator[tuple[Any, int, dict[str, Any]]]: ...

    def reset(self) -> None: ...

    def close(self) -> None: ...


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _verify_qwen_assets(
    path: Path, expected_path: Path, expected_sha256: str, label: str, *, assets: tuple[tuple[str, str], ...] = MODEL_ASSETS
) -> None:
    try:
        resolved = path.resolve(strict=True)
    except OSError as error:
        raise ValueError(f"pinned Qwen {label} path is missing") from error
    if resolved != expected_path.resolve():
        raise ValueError(f"Qwen {label} path does not match the pinned exact path")
    if not resolved.is_dir():
        raise ValueError(f"pinned Qwen {label} path is not a model directory")
    primary = resolved / "model.safetensors"
    if not primary.is_file() or _sha256_file(primary) != expected_sha256:
        raise ValueError("Qwen model bytes do not match the pinned SHA-256")
    for relative, expected in assets:
        asset = resolved / relative
        if not asset.is_file() or _sha256_file(asset) != expected:
            raise ValueError(f"Qwen model asset {relative} does not match the pinned SHA-256")


def _verify_base_assets(path: Path, expected_path: Path, expected_sha256: str, label: str) -> None:
    _verify_qwen_assets(path, expected_path, expected_sha256, label, assets=BASE_MODEL_ASSETS)


def _verify_lockfile() -> None:
    try:
        actual = _sha256_file(QWEN_REQUIREMENTS_PATH)
    except OSError as error:
        raise RuntimeError("Qwen runtime lock is missing") from error
    if actual != QWEN_REQUIREMENTS_LOCK_SHA256:
        raise RuntimeError("Qwen runtime lock SHA-256 does not match the pinned contract")


def _git_dir(source_root: Path) -> Path:
    marker = source_root / ".git"
    if marker.is_dir():
        return marker
    if marker.is_file():
        contents = marker.read_text(encoding="utf-8").strip()
        if contents.startswith("gitdir:"):
            target = Path(contents.split(":", 1)[1].strip())
            return (source_root / target).resolve() if not target.is_absolute() else target
    raise RuntimeError("faster-qwen3-tts source is not a git checkout")


def _git_commit(source_root: Path) -> str:
    git = _git_dir(source_root)
    head = (git / "HEAD").read_text(encoding="ascii").strip()
    if not head.startswith("ref: "):
        return head
    reference = head[5:].strip()
    ref_path = git / reference
    if ref_path.is_file():
        return ref_path.read_text(encoding="ascii").strip()
    packed = git / "packed-refs"
    if packed.is_file():
        for line in packed.read_text(encoding="ascii").splitlines():
            if line and not line.startswith(("#", "^")):
                commit, ref = line.split(" ", 1)
                if ref == reference:
                    return commit
    raise RuntimeError("faster-qwen3-tts HEAD reference is unavailable")


def _git_origin(source_root: Path) -> str | None:
    config = _git_dir(source_root) / "config"
    if not config.is_file():
        return None
    in_origin = False
    for raw_line in config.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if line.startswith("["):
            in_origin = line == '[remote "origin"]'
        elif in_origin and line.startswith("url") and "=" in line:
            return line.split("=", 1)[1].strip()
    return None


def _distribution_package_root(distribution: Any, package_name: str) -> Path:
    locate_file = getattr(distribution, "locate_file", None)
    if not callable(locate_file):
        raise RuntimeError(f"{package_name} distribution does not expose package files")
    try:
        package_file = Path(locate_file(f"{package_name}/__init__.py")).resolve()
    except (OSError, TypeError, ValueError) as error:
        raise RuntimeError(f"{package_name} package path cannot be resolved") from error
    if package_file.name != "__init__.py" or not package_file.is_file():
        raise RuntimeError(f"{package_name} package entry point is missing")
    return package_file.parent


def _verify_distribution_entrypoint(distribution: Any, package_name: str, package_root: Path) -> None:
    read_text = getattr(distribution, "read_text", None)
    record_text = read_text("RECORD") if callable(read_text) else None
    if not record_text:
        raise RuntimeError(f"{package_name} distribution lacks an integrity record")
    relative = f"{package_name}/__init__.py"
    expected_hash: str | None = None
    for row in csv.reader(io.StringIO(record_text)):
        if row and row[0] == relative and len(row) >= 2:
            expected_hash = row[1]
            break
    if not expected_hash or not expected_hash.startswith("sha256="):
        raise RuntimeError(f"{package_name} distribution lacks a hashed entry point")
    encoded = expected_hash.split("=", 1)[1]
    try:
        expected_digest = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))
    except (ValueError, TypeError) as error:
        raise RuntimeError(f"{package_name} distribution integrity record is invalid") from error
    entrypoint = package_root / "__init__.py"
    digest = hashlib.sha256(entrypoint.read_bytes()).digest()
    if digest != expected_digest:
        raise RuntimeError(f"{package_name} entry point bytes do not match its integrity record")
    spec = importlib.util.find_spec(package_name)
    origin = getattr(spec, "origin", None) if spec is not None else None
    if not origin or Path(origin).resolve() != entrypoint.resolve():
        raise RuntimeError(f"{package_name} import path is not bound to its pinned distribution")


def _verify_faster_package(package_root: Path) -> None:
    if package_root.name != "faster_qwen3_tts" or not package_root.is_dir():
        raise RuntimeError("faster-qwen3-tts package path is not canonical")
    expected = {relative for relative, _ in FASTER_PACKAGE_FILES}
    actual = {
        path.relative_to(package_root).as_posix()
        for path in package_root.rglob("*.py")
        if path.is_file()
    }
    if actual != expected:
        raise RuntimeError("faster-qwen3-tts package file set does not match the pinned source")
    for relative, expected_sha256 in FASTER_PACKAGE_FILES:
        path = package_root / relative
        if _sha256_file(path) != expected_sha256:
            raise RuntimeError(f"faster-qwen3-tts {relative} bytes do not match the pinned source")


def _distribution_license_path(distribution: Any) -> Path:
    files = getattr(distribution, "files", None) or ()
    candidates = [
        Path(distribution.locate_file(path)).resolve()
        for path in files
        if str(path).lower().endswith("/licenses/license") or str(path).lower().endswith("/license")
    ]
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    raise RuntimeError("faster-qwen3-tts license file is unavailable")


def _verify_faster_source() -> None:
    """Verify the faster package without importing its code.

    Editable installs are checked against the pinned checkout and an immutable
    package-file manifest.  A normal PEP 610 VCS install is checked against its
    direct-url commit and the same installed package-file manifest, so the
    adapter does not require a neighboring .git directory in production.
    """
    try:
        distribution = importlib.metadata.distribution("faster-qwen3-tts")
    except importlib.metadata.PackageNotFoundError as error:
        raise RuntimeError("faster-qwen3-tts runtime is not installed") from error

    read_text = getattr(distribution, "read_text", None)
    direct_url_text = read_text("direct_url.json") if callable(read_text) else None
    if not direct_url_text:
        raise RuntimeError("faster-qwen3-tts lacks verifiable origin metadata")
    try:
        direct_url = json.loads(direct_url_text)
    except json.JSONDecodeError as error:
        raise RuntimeError("faster-qwen3-tts origin metadata is invalid") from error

    direct_url_value = direct_url.get("url")
    verify_distribution_record = False
    if isinstance(direct_url_value, str) and direct_url_value.startswith("file://"):
        from urllib.parse import unquote, urlparse

        parsed = urlparse(direct_url_value)
        source_root = Path(unquote(parsed.path)).resolve()
        if _git_origin(source_root) != FASTER_REPO_URL:
            raise RuntimeError("faster-qwen3-tts origin does not match the pinned repository")
        if _git_commit(source_root) != FASTER_REPO_COMMIT:
            raise RuntimeError("faster-qwen3-tts source revision does not match the pinned commit")
        package_root = source_root / "faster_qwen3_tts"
        license_path = source_root / "LICENSE"
    elif direct_url_value == FASTER_REPO_URL:
        vcs = direct_url.get("vcs_info")
        if not isinstance(vcs, dict) or vcs.get("vcs") != "git":
            raise RuntimeError("faster-qwen3-tts origin metadata lacks Git identity")
        if vcs.get("commit_id") != FASTER_REPO_COMMIT:
            raise RuntimeError("faster-qwen3-tts source revision does not match the pinned commit")
        if vcs.get("requested_revision") not in (None, FASTER_REPO_COMMIT):
            raise RuntimeError("faster-qwen3-tts requested revision does not match the pinned commit")
        package_root = _distribution_package_root(distribution, "faster_qwen3_tts")
        license_path = _distribution_license_path(distribution)
        verify_distribution_record = True
    else:
        raise RuntimeError("faster-qwen3-tts origin does not match the pinned repository")

    _verify_faster_package(package_root)
    if verify_distribution_record:
        _verify_distribution_entrypoint(distribution, "faster_qwen3_tts", package_root)
    if not license_path.is_file() or _sha256_file(license_path) != FASTER_LICENSE_SHA256:
        raise RuntimeError("faster-qwen3-tts license bytes do not match the reviewed source")


def _verify_runtime_module_bindings() -> None:
    for distribution_name, package_name in RUNTIME_PACKAGES:
        try:
            distribution = importlib.metadata.distribution(distribution_name)
        except importlib.metadata.PackageNotFoundError as error:
            raise RuntimeError(f"{distribution_name} runtime is not installed") from error
        package_root = _distribution_package_root(distribution, package_name)
        _verify_distribution_entrypoint(distribution, package_name, package_root)


def _verify_runtime_distribution() -> None:
    _verify_lockfile()
    expected_versions = {
        "faster-qwen3-tts": FASTER_RUNTIME_VERSION,
        "qwen-tts": "0.1.1",
        "transformers": "4.57.3",
        "accelerate": "1.12.0",
        "torch": "2.12.1",
    }
    for package, expected in expected_versions.items():
        try:
            distribution = importlib.metadata.distribution(package)
        except importlib.metadata.PackageNotFoundError as error:
            raise RuntimeError(f"{package} runtime is not installed") from error
        if distribution.version != expected:
            raise RuntimeError(f"{package} version does not match the pinned contract")
    _verify_faster_source()
    _verify_runtime_module_bindings()

    try:
        import torch
    except ImportError as error:
        raise RuntimeError("pinned Qwen Torch runtime is unavailable") from error
    if torch.version.cuda != "13.0":
        raise RuntimeError("Torch CUDA version does not match the pinned contract")


_CANONICAL_VOICE_LABELS = {
    "aiden": "Aiden",
    "dylan": "Dylan",
    "eric": "Eric",
    "ono_anna": "Ono Anna",
    "ryan": "Ryan",
    "serena": "Serena",
    "sohee": "Sohee",
    "uncle_fu": "Uncle Fu",
    "vivian": "Vivian",
}


@dataclass
class FasterQwenTorchBackend:
    """The pinned faster-qwen3-tts Torch CUDA-graph implementation."""

    model: Any = None
    poisoned: bool = False
    voices: tuple[str, ...] = ()

    def prepare(
        self, model_path: str, device: str, dtype: str, attn_implementation: str
    ) -> None:
        import torch

        if dtype != PRECISION:
            raise ValueError("pinned Qwen runtime requires bfloat16")
        if attn_implementation != ATTENTION:
            raise ValueError("pinned Qwen runtime requires eager attention")
        if not torch.cuda.is_available():
            raise RuntimeError("CUDA is unavailable")
        if not device.startswith("cuda"):
            raise ValueError("pinned faster Qwen backend requires a CUDA device")

        from faster_qwen3_tts import FasterQwen3TTS

        self.model = FasterQwen3TTS.from_pretrained(
            model_path,
            device=device,
            dtype=torch.bfloat16,
            attn_implementation=attn_implementation,
            max_seq_len=2_048,
            backend="torch",
            local_files_only=True,
        )
        config = getattr(getattr(getattr(self.model, "model", None), "model", None), "config", None)
        talker_config = getattr(config, "talker_config", None)
        speaker_ids = getattr(talker_config, "spk_id", None)
        if not isinstance(speaker_ids, dict) or not speaker_ids:
            raise RuntimeError("pinned Qwen model exposed no verified speaker catalog")
        # Keep the model's native IDs here.  The adapter may expose friendly
        # catalog labels, but faster-qwen resolves speaker names against keys
        # such as ``ono_anna`` and ``uncle_fu``.
        self.voices = tuple(sorted(str(name) for name in speaker_ids))
        if "ryan" not in {voice.lower() for voice in self.voices}:
            raise RuntimeError("pinned Qwen model does not expose the default speaker")

    def get_voices(self) -> list[str]:
        if self.model is None or not self.voices:
            raise RuntimeError("Qwen backend is not prepared")
        return list(self.voices)

    def create_stream(
        self, text: str, speaker: str, language: str, tone_prompt: str | None = None
    ) -> Iterator[tuple[Any, int, dict[str, Any]]]:
        if self.model is None:
            raise RuntimeError("Qwen backend is not prepared")
        # This is intentionally the faster wrapper's generator API.  The
        # official qwen-tts generate_custom_voice() method returns a complete
        # waveform and is never used as an adapter stream.
        return self.model.generate_custom_voice_streaming(
            text=text,
            speaker=speaker,
            language=language,
            instruct=tone_prompt,
            non_streaming_mode=True,
            max_new_tokens=MAX_NEW_TOKENS,
            min_new_tokens=MIN_NEW_TOKENS,
            temperature=TEMPERATURE,
            top_k=TOP_K,
            top_p=TOP_P,
            do_sample=DO_SAMPLE,
            repetition_penalty=REPETITION_PENALTY,
            chunk_size=CHUNK_SIZE_CODEC_STEPS,
        )

    def reset(self) -> None:
        if self.poisoned:
            raise RuntimeError("cannot reset a poisoned Qwen backend")
        if self.model is None:
            raise RuntimeError("Qwen backend is not prepared")

    def close(self) -> None:
        self.model = None
        self.voices = ()
        try:
            import torch

            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except ImportError:
            pass


class FasterQwenBaseCloneBackend:
    """Pinned Base-model clone backend behind the same injectable factory shape.

    The Base model has no fixed speaker catalog; ``get_voices`` is empty by
    design and every synthesis is driven by a precomputed x-vector prompt
    extracted from an enrolled user reference.
    """

    poisoned: bool = False

    def __init__(self) -> None:
        self.model: Any = None
        self.poisoned = False

    def prepare(
        self, model_path: str, device: str, dtype: str, attn_implementation: str
    ) -> None:
        import torch

        if dtype != PRECISION:
            raise ValueError("pinned Qwen clone runtime requires bfloat16")
        if attn_implementation != ATTENTION:
            raise ValueError("pinned Qwen clone runtime requires eager attention")
        if not torch.cuda.is_available():
            raise RuntimeError("CUDA is unavailable")
        if not device.startswith("cuda"):
            raise ValueError("pinned faster Qwen clone backend requires a CUDA device")

        from faster_qwen3_tts import FasterQwen3TTS

        self.model = FasterQwen3TTS.from_pretrained(
            model_path,
            device=device,
            dtype=torch.bfloat16,
            attn_implementation=attn_implementation,
            max_seq_len=2_048,
            backend="torch",
            local_files_only=True,
        )
        config_path = Path(model_path) / "config.json"
        try:
            model_type = json.loads(config_path.read_text(encoding="utf-8")).get("tts_model_type")
        except (OSError, ValueError, TypeError) as error:
            raise RuntimeError("pinned Qwen clone model config is unreadable") from error
        if model_type != "base":
            raise RuntimeError(f"pinned Qwen clone model is not a Base model: {model_type!r}")

    def create_stream(
        self, text: str, prompt: dict[str, Any], language: str, tone_prompt: str | None = None
    ) -> Iterator[tuple[Any, int, dict[str, Any]]]:
        if self.model is None:
            raise RuntimeError("Qwen clone backend is not prepared")
        return self.model.generate_voice_clone_streaming(
            text=text,
            language=language,
            voice_clone_prompt=prompt,
            instruct=tone_prompt,
            non_streaming_mode=False,
            max_new_tokens=MAX_NEW_TOKENS,
            min_new_tokens=MIN_NEW_TOKENS,
            temperature=TEMPERATURE,
            top_k=TOP_K,
            top_p=TOP_P,
            do_sample=DO_SAMPLE,
            repetition_penalty=REPETITION_PENALTY,
            chunk_size=CHUNK_SIZE_CODEC_STEPS,
        )

    def reset(self) -> None:
        if self.poisoned:
            raise RuntimeError("cannot reset a poisoned Qwen clone backend")
        if self.model is None:
            raise RuntimeError("Qwen clone backend is not prepared")

    def close(self) -> None:
        self.model = None
        self.poisoned = False
        try:
            import torch

            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except ImportError:
            pass


def _to_cpu_prompt(value: Any, torch_module: Any) -> Any:
    """Move a voice-clone prompt {dict,list,tuple,tensor} to CPU tensors."""
    if isinstance(value, dict):
        return {key: _to_cpu_prompt(item, torch_module) for key, item in value.items()}
    if isinstance(value, list):
        return [_to_cpu_prompt(item, torch_module) for item in value]
    if isinstance(value, tuple):
        return tuple(_to_cpu_prompt(item, torch_module) for item in value)
    if isinstance(value, torch_module.Tensor):
        return value.detach().cpu()
    return value


def _to_device_prompt(value: Any, torch_module: Any, device: str) -> Any:
    """Move a CPU voice-clone prompt to the pinned CUDA device per request."""
    if isinstance(value, dict):
        return {key: _to_device_prompt(item, torch_module, device) for key, item in value.items()}
    if isinstance(value, list):
        return [_to_device_prompt(item, torch_module, device) for item in value]
    if isinstance(value, tuple):
        return tuple(_to_device_prompt(item, torch_module, device) for item in value)
    if isinstance(value, torch_module.Tensor):
        return value.to(device)
    return value


def _audio_values(samples: Any) -> Any:
    import numpy as np

    value = samples
    if hasattr(value, "detach"):
        value = value.detach()
    if hasattr(value, "float"):
        value = value.float()
    if hasattr(value, "cpu"):
        value = value.cpu()
    if hasattr(value, "numpy"):
        value = value.numpy()
    array = np.asarray(value, dtype=np.float32)
    if array.ndim == 0 or array.ndim > 2 or (array.ndim == 2 and 1 not in array.shape):
        raise ValueError("Qwen emitted non-mono audio")
    values = array.reshape(-1)
    if not values.size:
        raise ValueError("Qwen produced an empty audio packet")
    if not np.isfinite(values).all():
        raise ValueError("Qwen produced non-finite audio")
    return values


def _pcm16(samples: Any, gain: float) -> bytes:
    import numpy as np

    values = _audio_values(samples)
    scaled = values * gain
    if float(np.max(np.abs(scaled))) > 1.0:
        raise ValueError("Qwen output would clip under the pinned gain policy")
    scaled = np.clip(scaled, -1.0, 32767.0 / 32768.0)
    return np.rint(scaled * 32768.0).astype("<i2").tobytes()


def _packet(value: Any) -> tuple[Any, int]:
    from numbers import Integral

    if not isinstance(value, tuple) or len(value) not in (2, 3):
        raise RuntimeError("Qwen emitted an unexpected streaming packet")
    samples, sample_rate = value[0], value[1]
    if isinstance(sample_rate, bool) or not isinstance(sample_rate, Integral):
        raise RuntimeError("Qwen emitted an invalid sample rate")
    return samples, int(sample_rate)


@dataclass
class Qwen3StreamingAdapter:
    backend_factory: Callable[[], QwenBackend] = FasterQwenTorchBackend
    asset_verifier: Callable[[Path, Path, str, str], None] = _verify_qwen_assets
    expected_model_path: Path = MODEL_PATH
    clone_backend_factory: Callable[[], QwenBackend] = FasterQwenBaseCloneBackend
    clone_asset_verifier: Callable[[Path, Path, str, str], None] = _verify_base_assets
    expected_clone_model_path: Path = BASE_MODEL_PATH
    runtime_verifier: Callable[[], None] = _verify_runtime_distribution
    backend: QwenBackend | None = None
    prepared: bool = False
    closed: bool = False
    generation: int = 0
    voice: str = SPEAKER
    language: str = LANGUAGE
    speed: float = 1.0
    gain: float = 0.9
    chunk_samples: int = CHUNK_SAMPLES
    max_text_characters: int = MAX_TEXT_CHARACTERS
    worker_timeout_seconds: float = 10.0
    _active: bool = False
    _poisoned: bool = False
    _voices: tuple[str, ...] = ()
    _native_voices: dict[str, str] = field(default_factory=dict)
    _clone_backend: QwenBackend | None = None
    _custom_voices: dict[str, dict[str, object]] = field(default_factory=dict)
    _lock: threading.RLock = field(default_factory=threading.RLock)
    _workers: set[threading.Thread] = field(default_factory=set)

    def prepare(self, config: dict[str, object]) -> None:
        with self._lock:
            if self.closed:
                raise RuntimeError("adapter is closed")
            if self._active:
                raise RuntimeError("cannot prepare during active synthesis")
            if self.prepared:
                raise RuntimeError("adapter is already prepared")

            candidate = config.get("candidate")
            if not isinstance(candidate, dict) or candidate.get("id") != CANDIDATE_ID:
                raise ValueError("Qwen candidate config is required")
            expected_candidate = {
                "modelId": MODEL_ID,
                "revision": MODEL_REVISION,
                "runtime": RUNTIME_CONTRACT,
                "runtimeRevision": FASTER_REPO_COMMIT,
                "runtimeLockSha256": QWEN_REQUIREMENTS_LOCK_SHA256,
                "modelSha256": MODEL_SHA256,
                "voice": SPEAKER,
                "provider": PROVIDER,
                "precision": PRECISION,
                "backend": BACKEND,
                "device": MANIFEST_DEVICE,
            }
            for key, value in expected_candidate.items():
                if candidate.get(key) != value:
                    raise ValueError(f"Qwen candidate {key} does not match the pinned contract")
            optional_candidate = {
                "fasterRuntimeRevision": FASTER_REPO_COMMIT,
                "fasterVersion": FASTER_RUNTIME_VERSION,
                "officialRuntime": OFFICIAL_RUNTIME_CONTRACT,
                "runtimeLock": "services/audio/qwen-requirements.lock",
            }
            for key, value in optional_candidate.items():
                if key in candidate and candidate.get(key) != value:
                    raise ValueError(f"Qwen candidate {key} does not match the pinned contract")

            expected_top_level = {
                "language": LANGUAGE,
                "nativeSampleRate": SAMPLE_RATE,
                "comparisonSampleRate": SAMPLE_RATE,
                "outputFormat": OUTPUT_FORMAT,
                "channels": 1,
                "sampleWidthBytes": 2,
                "chunkMs": 20,
                "gain": 0.9,
                "speed": 1.0,
                "resampler": "none",
                "timingMode": "harness-monotonic-request-first-audio-completion-v2",
                "timingBoundary": "harness-before-adapter-call-through-adapter-return-v1",
                "playbackBufferMs": 100,
                "rssScope": "synthesis-window-whole-process-rss-v1",
                "device": DEVICE,
                "dtype": PRECISION,
                "attnImplementation": ATTENTION,
                "backend": BACKEND,
                "chunkSizeCodecSteps": CHUNK_SIZE_CODEC_STEPS,
            }
            for key, value in expected_top_level.items():
                actual = config.get(key)
                if key == "attnImplementation" and key not in config:
                    actual = config.get("attn_implementation")
                if key == "chunkSizeCodecSteps" and key not in config:
                    actual = config.get("chunkSize")
                if actual != value:
                    raise ValueError(f"Qwen {key} does not match the pinned contract")
            optional_top_level = {
                "maxNewTokens": MAX_NEW_TOKENS,
                "minNewTokens": MIN_NEW_TOKENS,
                "temperature": TEMPERATURE,
                "topK": TOP_K,
                "topP": TOP_P,
                "doSample": DO_SAMPLE,
                "repetitionPenalty": REPETITION_PENALTY,
            }
            for key, value in optional_top_level.items():
                if key in config and config.get(key) != value:
                    raise ValueError(f"Qwen {key} does not match the pinned contract")

            model_path = str(config.get("modelPath", ""))
            if not model_path:
                raise ValueError("verified Qwen modelPath is required")

            # Verify the lock, package identities, source revision, and all model
            # assets before allowing the backend to import/load model weights.
            self.runtime_verifier()
            self.asset_verifier(Path(model_path), self.expected_model_path, MODEL_SHA256, "model")
            backend = self.backend_factory()
            try:
                backend.prepare(model_path, DEVICE, PRECISION, ATTENTION)
                native_voices = tuple(sorted(set(str(value) for value in backend.get_voices())))
                voice_map: dict[str, str] = {}
                for native in native_voices:
                    label = _CANONICAL_VOICE_LABELS.get(native.lower(), native)
                    if label in voice_map and voice_map[label] != native:
                        raise ValueError("verified Qwen model exposed ambiguous speaker IDs")
                    voice_map[label] = native
                voices = tuple(sorted(voice_map))
                if not voices or SPEAKER not in voices:
                    raise ValueError("verified Qwen model exposed no usable speaker catalog")
            except BaseException:
                try:
                    backend.close()
                finally:
                    raise
            self.backend = backend
            self._voices = voices
            self._native_voices = voice_map
            self.voice = SPEAKER
            self.language = LANGUAGE
            self.speed = 1.0
            self.gain = 0.9
            self.chunk_samples = CHUNK_SAMPLES
            self.prepared = True

    def _register(self, thread: threading.Thread) -> None:
        with self._lock:
            self._workers.add(thread)

    def _unregister_dead(self) -> None:
        with self._lock:
            self._workers = {worker for worker in self._workers if worker.is_alive()}

    @property
    def worker_names(self) -> tuple[str, ...]:
        self._unregister_dead()
        registered = {worker.name for worker in self._workers if worker.is_alive()}
        owned = {
            worker.name
            for worker in threading.enumerate()
            if worker.is_alive()
            and any(worker.name.startswith(prefix) for prefix in OWNED_THREAD_PREFIXES)
        }
        return tuple(sorted(registered | owned))

    def get_voices(self) -> list[dict[str, str]]:
        with self._lock:
            if not self.prepared or not self._voices:
                raise RuntimeError("voice catalog is unavailable until the adapter is prepared")
            voices = [{"id": voice, "label": voice} for voice in self._voices]
            voices.extend(
                {"id": voice_id, "label": str(entry["label"])}
                for voice_id, entry in sorted(self._custom_voices.items())
            )
            return voices

    def has_voice(self, voice_id: str) -> bool:
        with self._lock:
            return self.prepared and (voice_id in self._voices or voice_id in self._custom_voices)

    def custom_voices(self) -> list[dict[str, str]]:
        with self._lock:
            return [
                {"voiceId": voice_id, "label": str(entry["label"]), "refSha256": str(entry["refSha256"])}
                for voice_id, entry in sorted(self._custom_voices.items())
            ]

    def _prompt_to_cpu(self, prompt: dict[str, Any]) -> dict[str, Any]:
        import torch

        return _to_cpu_prompt(prompt, torch)

    def _prompt_to_device(self, prompt: dict[str, Any]) -> dict[str, Any]:
        import torch

        return _to_device_prompt(prompt, torch, DEVICE)

    def _extract_user_prompt(self, decoded) -> dict[str, Any]:
        """Extract a deterministic x-vector prompt from one validated reference.

        x-vector-only mode needs no transcript, so no speech content is ever
        transcribed or retained as text (decision 008). The prompt is moved to
        CPU tensors and kept only inside this adapter instance.
        """
        import numpy as np

        backend = self._clone_backend
        if backend is None or not getattr(backend, "model", None):
            raise RuntimeError("Qwen clone backend is not prepared")
        audio = np.frombuffer(decoded.pcm16, dtype="<i2").astype(np.float32) / 32768.0
        model = getattr(backend, "model", None)
        prompt_items = model.model.create_voice_clone_prompt(
            ref_audio=(audio, CUSTOM_VOICE_SAMPLE_RATE),
            ref_text="",
            x_vector_only_mode=True,
        )
        prompt = model.model._prompt_items_to_voice_clone_prompt(prompt_items)
        return self._prompt_to_cpu(prompt)

    def _ensure_clone_backend(self) -> None:
        if self._clone_backend is not None:
            return
        self.clone_asset_verifier(self.expected_clone_model_path, self.expected_clone_model_path, BASE_MODEL_SHA256, "clone model")
        backend = self.clone_backend_factory()
        try:
            backend.prepare(str(self.expected_clone_model_path), DEVICE, PRECISION, ATTENTION)
        except BaseException:
            try:
                backend.close()
            finally:
                raise
        self._clone_backend = backend

    def enroll_custom_voice(
        self, voice_id: str, name: str, ref_sha256: str, wav_bytes: bytes
    ) -> None:
        """Enroll one user reference and cache its deterministic clone prompt.

        The same reference bytes always yield the same voice id and the same
        prompt; a re-enroll with an unchanged hash only refreshes the label.
        Bounded: at most MAX_CUSTOM_VOICES prompts are retained, each a few KB
        of CPU tensors, and the raw reference is released after extraction.
        """
        validate_voice_id(voice_id, ref_sha256)
        if hashlib.sha256(wav_bytes).hexdigest() != ref_sha256:
            raise ValueError("reference digest does not match its bytes")
        normalized_name = validate_name(name)
        decoded = decode_reference(wav_bytes)
        with self._lock:
            if self.closed:
                raise RuntimeError("adapter is closed")
            if not self.prepared:
                raise RuntimeError("adapter is not prepared")
            if self._active:
                raise RuntimeError("cannot enroll during active synthesis")
            if self._poisoned or bool(getattr(self.backend, "poisoned", False)):
                raise RuntimeError("Qwen backend is poisoned")
            existing = self._custom_voices.get(voice_id)
            if existing is not None and existing.get("refSha256") == ref_sha256:
                existing["label"] = normalized_name
                return
            if existing is None and len(self._custom_voices) >= MAX_CUSTOM_VOICES:
                raise RuntimeError("custom voice limit reached")
            self._ensure_clone_backend()
            if self._poisoned or bool(getattr(self._clone_backend, "poisoned", False)):
                raise RuntimeError("Qwen clone backend is poisoned")
            prompt = self._extract_user_prompt(decoded)
            self._custom_voices[voice_id] = {
                "label": normalized_name,
                "refSha256": ref_sha256,
                "prompt": prompt,
                "durationMs": decoded.duration_ms,
            }

    def remove_custom_voice(self, voice_id: str) -> bool:
        with self._lock:
            existing = self._custom_voices.pop(voice_id, None)
            if existing is not None and not self._custom_voices and not self._active and self._clone_backend is not None:
                self._clone_backend.close()
                self._clone_backend = None
        return existing is not None

    def voice_catalog(self) -> dict[str, object]:
        with self._lock:
            if not self.prepared or not self._voices:
                raise RuntimeError("voice catalog is unavailable until the adapter is prepared")
            digest = hashlib.sha256()
            for part in (
                "qwen3",
                MODEL_ID,
                TTS_CONFIG_ID,
                MODEL_REVISION,
                FASTER_REPO_COMMIT,
                *self._voices,
            ):
                digest.update(part.encode("utf-8"))
            # User voices are appended after the stock catalog. The catalogId is
            # deliberately stock-derived: admission stays stable and a rename or
            # re-enrollment never invalidates an open stream (decision 008).
            voices = [{"id": voice, "label": voice} for voice in self._voices]
            for voice_id, entry in sorted(self._custom_voices.items()):
                voices.append({"id": voice_id, "label": str(entry["label"])})
            return {
                "catalogId": digest.hexdigest()[:16],
                "backendId": "qwen3",
                "modelId": MODEL_ID,
                "runtimeConfigId": TTS_CONFIG_ID,
                "revision": MODEL_REVISION,
                "defaultVoiceId": SPEAKER,
                # faster-qwen's CustomVoice generator has no playback-speed
                # parameter. Keep this explicit so a Kokoro speed is never
                # silently presented as a Qwen capability.
                "speed": speed_capability(supported=False, minimum=1.0, maximum=1.0, default=1.0),
                "voices": voices,
            }

    def synthesize_stream(
        self,
        text: str,
        cancel: Cancellation,
        on_audio: AudioCallback | None = None,
        voice: str | None = None,
        tone_prompt: str | None = None,
    ) -> SynthesisResult:
        text = validate_text(text, self.max_text_characters)
        if tone_prompt is not None:
            tone_prompt = tone_prompt.strip()
            if len(tone_prompt.encode("utf-8")) > MAX_VOICE_TONE_PROMPT_BYTES:
                raise ValueError("Qwen tone prompt exceeds the configured byte limit")
        cancel.raise_if_cancelled()
        with self._lock:
            if not self.prepared or self.closed or self.backend is None:
                raise RuntimeError("adapter is not prepared")
            if self._poisoned or bool(getattr(self.backend, "poisoned", False)):
                raise RuntimeError("Qwen backend is poisoned")
            if self._active:
                raise RuntimeError("adapter synthesis is already active")
            selected_voice = self.voice if voice is None else voice
            custom_voice = self._custom_voices.get(selected_voice)
            if selected_voice not in self._voices and custom_voice is None:
                raise ValueError("requested voice is absent from the verified catalog")
            native_voice = self._native_voices.get(selected_voice)
            if custom_voice is not None and self._clone_backend is None:
                raise RuntimeError("custom voice prompt is unavailable")
            self._active = True
            backend = self.backend
            clone_backend = self._clone_backend
            custom_prompt = custom_voice.get("prompt") if custom_voice is not None else None

        started = time.perf_counter()
        inference_queue: queue.Queue[bytes | BaseException | None] = queue.Queue(maxsize=2)
        output_queue: queue.Queue[bytes | BaseException | None] = queue.Queue(maxsize=2)
        stop = threading.Event()
        output_failure: list[BaseException] = []
        stats = {"samples": 0, "chunks": 0}
        digest = hashlib.sha256()

        def put_bounded(
            target: queue.Queue[bytes | BaseException | None],
            value: bytes | BaseException | None,
        ) -> bool:
            while not stop.is_set():
                if cancel.cancelled:
                    return False
                try:
                    target.put(value, timeout=0.02)
                    return True
                except queue.Full:
                    continue
            return False

        def infer() -> None:
            try:
                pcm_buffer = bytearray()
                frame_bytes = self.chunk_samples * 2
                for segment in segment_text(text):
                    cancel.raise_if_cancelled()
                    if custom_prompt is not None:
                        if clone_backend is None:
                            raise RuntimeError("Qwen clone backend is unavailable")
                        if not isinstance(custom_prompt, dict):
                            raise RuntimeError("custom voice prompt is malformed")
                        stream = (clone_backend.create_stream(
                            segment,
                            self._prompt_to_device(custom_prompt),
                            self.language,
                            tone_prompt=tone_prompt,
                        ) if tone_prompt is not None else clone_backend.create_stream(
                            segment,
                            self._prompt_to_device(custom_prompt),
                            self.language,
                        ))
                    else:
                        if native_voice is None:
                            raise RuntimeError("stock Qwen voice is unavailable")
                        stream = (backend.create_stream(segment, native_voice, self.language, tone_prompt=tone_prompt)
                                  if tone_prompt is not None
                                  else backend.create_stream(segment, native_voice, self.language))
                    try:
                        for native in stream:
                            cancel.raise_if_cancelled()
                            samples, sample_rate = _packet(native)
                            if sample_rate != SAMPLE_RATE:
                                raise RuntimeError("Qwen emitted an unexpected sample rate")
                            pcm_buffer.extend(_pcm16(samples, self.gain))
                            while len(pcm_buffer) >= frame_bytes:
                                chunk = bytes(pcm_buffer[:frame_bytes])
                                del pcm_buffer[:frame_bytes]
                                if not put_bounded(inference_queue, chunk):
                                    return
                    finally:
                        close = getattr(stream, "close", None)
                        if callable(close):
                            close()
                if pcm_buffer and not cancel.cancelled:
                    put_bounded(inference_queue, bytes(pcm_buffer))
            except BaseException as error:
                put_bounded(inference_queue, error)
            finally:
                put_bounded(inference_queue, None)

        def output_worker() -> None:
            sequence = 0
            sample_offset = 0
            while not stop.is_set():
                try:
                    value = output_queue.get(timeout=0.02)
                except queue.Empty:
                    continue
                if value is None:
                    return
                if isinstance(value, BaseException):
                    output_failure.append(value)
                    return
                try:
                    if not value or len(value) % 2:
                        raise RuntimeError("Qwen emitted malformed PCM framing")
                    chunk = AudioChunk(sequence, value, SAMPLE_RATE, sample_offset)

                    def accept() -> None:
                        if on_audio is not None:
                            on_audio(chunk)
                        digest.update(value)
                        stats["samples"] += chunk.samples
                        stats["chunks"] += 1

                    cancel.accept_unless_cancelled(accept)
                    sequence += 1
                    sample_offset += chunk.samples
                except BaseException as error:
                    output_failure.append(error)
                    stop.set()
                    return

        inference_thread = threading.Thread(
            target=infer, name="qwen-inference", daemon=True
        )
        output_thread = threading.Thread(
            target=output_worker, name="qwen-output", daemon=True
        )
        self._register(inference_thread)
        self._register(output_thread)
        inference_thread.start()
        output_thread.start()
        primary_error: BaseException | None = None
        try:
            while True:
                cancel.raise_if_cancelled()
                if output_failure:
                    raise output_failure[0]
                try:
                    value = inference_queue.get(timeout=0.02)
                except queue.Empty:
                    if not inference_thread.is_alive():
                        raise RuntimeError("Qwen inference ended without a terminal record")
                    continue
                if value is None:
                    put_bounded(output_queue, None)
                    break
                if isinstance(value, BaseException):
                    raise value
                if not put_bounded(output_queue, value):
                    cancel.raise_if_cancelled()
                    raise RuntimeError("Qwen output queue stopped")
            inference_thread.join(timeout=self.worker_timeout_seconds)
            output_thread.join(timeout=self.worker_timeout_seconds)
            cancel.raise_if_cancelled()
            if output_failure:
                raise output_failure[0]
            if stats["samples"] <= 0:
                raise RuntimeError("Qwen produced no audio")
        except BaseException as error:
            primary_error = error
            stop.set()
            while True:
                try:
                    inference_queue.get_nowait()
                except queue.Empty:
                    break
            while True:
                try:
                    output_queue.get_nowait()
                except queue.Empty:
                    break
            inference_thread.join(timeout=self.worker_timeout_seconds)
            output_thread.join(timeout=self.worker_timeout_seconds)
        finally:
            alive = [worker for worker in (inference_thread, output_thread) if worker.is_alive()]
            if alive:
                self._poisoned = True
                try:
                    backend.poisoned = True
                except AttributeError:
                    pass
            self._unregister_dead()
            with self._lock:
                self._active = False

        if inference_thread.is_alive() or output_thread.is_alive():
            names = ", ".join(
                worker.name
                for worker in (inference_thread, output_thread)
                if worker.is_alive()
            )
            raise RuntimeError(f"Qwen workers did not stop; backend poisoned: {names}") from primary_error
        if primary_error is not None:
            if cancel.cancelled:
                cancel.raise_if_cancelled()
            raise RuntimeError(f"Qwen synthesis failed: {type(primary_error).__name__}") from primary_error
        processing = time.perf_counter() - started
        return SynthesisResult(
            sample_rate=SAMPLE_RATE,
            total_samples=stats["samples"],
            audio_seconds=stats["samples"] / SAMPLE_RATE,
            processing_seconds=processing,
            sha256=digest.hexdigest(),
            chunk_count=stats["chunks"],
        )

    def synthesize(self, text: str, cancel: Cancellation) -> Iterator[bytes]:
        chunks: list[bytes] = []
        self.synthesize_stream(text, cancel, lambda chunk: chunks.append(chunk.pcm16))
        return iter(chunks)

    def reset(self) -> None:
        with self._lock:
            if self.closed or not self.prepared or self.backend is None:
                raise RuntimeError("adapter is closed or unprepared")
            if self._active:
                raise RuntimeError("cannot reset active synthesis")
            if self._poisoned or bool(getattr(self.backend, "poisoned", False)):
                raise RuntimeError("cannot reset a poisoned Qwen backend")
            if self._clone_backend is not None and bool(getattr(self._clone_backend, "poisoned", False)):
                raise RuntimeError("cannot reset a poisoned Qwen clone backend")
            self.backend.reset()
            if self._clone_backend is not None:
                self._clone_backend.reset()
            self.generation += 1

    def close(self) -> None:
        with self._lock:
            if self.closed:
                return
            if self._active:
                raise RuntimeError("cannot close active synthesis")
            if self.worker_names:
                self._poisoned = True
                raise RuntimeError("cannot close while Qwen workers survive")
            if self.backend is not None:
                self.backend.close()
            if self._clone_backend is not None:
                self._clone_backend.close()
            self.backend = None
            self._clone_backend = None
            self._custom_voices.clear()
            self._voices = ()
            self._native_voices = {}
            self.prepared = False
            self.closed = True


# Keep both spellings available while the candidate remains replaceable behind
# the shared StreamingTtsAdapter protocol.
QwenStreamingAdapter = Qwen3StreamingAdapter
QwenTorchBackend = FasterQwenTorchBackend
FasterQwen3TTSBackend = FasterQwenTorchBackend

__all__ = [
    "ATTENTION",
    "BACKEND",
    "BASE_MODEL_ID",
    "BASE_MODEL_PATH",
    "BASE_MODEL_REVISION",
    "BASE_MODEL_SHA256",
    "CANDIDATE_ID",
    "CHUNK_SIZE",
    "CHUNK_SIZE_CODEC_STEPS",
    "DEVICE",
    "FASTER_REPO_COMMIT",
    "FASTER_RUNTIME_REVISION",
    "FasterQwen3TTSBackend",
    "FasterQwenBaseCloneBackend",
    "LANGUAGE",
    "MODEL_ID",
    "MODEL_PATH",
    "MODEL_REVISION",
    "MODEL_SHA256",
    "OFFICIAL_RUNTIME_CONTRACT",
    "PRECISION",
    "PROVIDER",
    "QWEN_LOCK_SHA256",
    "QWEN_REQUIREMENTS_LOCK_SHA256",
    "Qwen3StreamingAdapter",
    "QwenStreamingAdapter",
    "QwenTorchBackend",
    "RUNTIME_CONTRACT",
    "RUNTIME_LOCK_SHA256",
    "RUNTIME_REVISION",
    "RUNTIME_VERSION",
    "SAMPLE_RATE",
    "SPEAKER",
    "VOICE",
    "_verify_base_assets",
    "_verify_faster_source",
    "_verify_qwen_assets",
    "_verify_runtime_distribution",
]
