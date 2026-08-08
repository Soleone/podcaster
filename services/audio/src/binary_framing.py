"""Binary PCM frame v1 shared with the TypeScript contracts package."""
from __future__ import annotations

import struct
from dataclasses import dataclass

VERSION = 1
HEADER_BYTES = 20
_HEADER = struct.Struct("<BBHIIQ")

@dataclass(frozen=True)
class BinaryAudioFrame:
    channel: int
    stream_id: int
    sequence: int
    monotonic_us: int
    pcm16: bytes

def encode_frame(frame: BinaryAudioFrame, max_payload_bytes: int) -> bytes:
    if frame.channel not in (1, 2):
        raise ValueError("unsupported audio channel")
    if len(frame.pcm16) % 2:
        raise ValueError("PCM16 payload has odd byte length")
    if len(frame.pcm16) > max_payload_bytes:
        raise ValueError("PCM payload exceeds negotiated frame size")
    if not (0 <= frame.stream_id <= 0xFFFFFFFF and 0 <= frame.sequence <= 0xFFFFFFFF):
        raise ValueError("stream_id and sequence must be uint32")
    if not 0 <= frame.monotonic_us <= 0xFFFFFFFFFFFFFFFF:
        raise ValueError("monotonic_us must be uint64")
    return _HEADER.pack(VERSION, frame.channel, HEADER_BYTES, frame.stream_id, frame.sequence, frame.monotonic_us) + frame.pcm16

def decode_frame(data: bytes, max_payload_bytes: int) -> BinaryAudioFrame:
    if len(data) < HEADER_BYTES:
        raise ValueError("truncated binary frame")
    version, channel, header_bytes, stream_id, sequence, monotonic_us = _HEADER.unpack_from(data)
    if version != VERSION:
        raise ValueError("unsupported binary frame version")
    if channel not in (1, 2):
        raise ValueError("unsupported audio channel")
    if header_bytes != HEADER_BYTES:
        raise ValueError("invalid binary header length")
    payload = data[header_bytes:]
    if len(payload) > max_payload_bytes:
        raise ValueError("PCM payload exceeds negotiated frame size")
    if len(payload) % 2:
        raise ValueError("PCM16 payload has odd byte length")
    return BinaryAudioFrame(channel, stream_id, sequence, monotonic_us, payload)
