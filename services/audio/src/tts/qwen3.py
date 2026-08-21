"""Compatibility facade for the split :mod:`tts.qwen` implementation.

New code should import backends and the adapter from ``tts.qwen``.  This module
keeps the historical import path stable for integrations and older workers.
"""

from .qwen import *  # noqa: F401,F403
from .qwen import __all__
from .qwen.adapter import (  # noqa: F401
    _audio_values,
    _packet,
    _pcm16,
    _to_cpu_prompt,
    _to_device_prompt,
)
from .qwen.backends import (
    BASE_TTS_CONFIG_ID,
    FASTER_LICENSE_SHA256,
    FASTER_PACKAGE_FILES,
    FASTER_REPO_URL,
    FASTER_RUNTIME_VERSION,
    MAX_NEW_TOKENS,
    MIN_NEW_TOKENS,
    MODEL_ASSETS,
    OWNED_THREAD_PREFIXES,
    QWEN_REQUIREMENTS_PATH,
    TTS_CONFIG_ID,
    _verify_base_assets,
    _verify_faster_source,
    _verify_lockfile,
    _verify_qwen_assets,
    _verify_runtime_distribution,
    _verify_runtime_module_bindings,
)
from ..voice_enrollment import CUSTOM_VOICE_SAMPLE_RATE

__all__ = [
    *__all__,
    "BASE_TTS_CONFIG_ID",
    "CUSTOM_VOICE_SAMPLE_RATE",
    "FASTER_LICENSE_SHA256",
    "FASTER_PACKAGE_FILES",
    "FASTER_REPO_URL",
    "FASTER_RUNTIME_VERSION",
    "MAX_NEW_TOKENS",
    "MIN_NEW_TOKENS",
    "MODEL_ASSETS",
    "OWNED_THREAD_PREFIXES",
    "QWEN_REQUIREMENTS_PATH",
    "TTS_CONFIG_ID",
    "_verify_base_assets",
    "_verify_faster_source",
    "_verify_lockfile",
    "_verify_qwen_assets",
    "_verify_runtime_distribution",
    "_verify_runtime_module_bindings",
]
