"""Deterministic original launch Foley: four elastic pulls, a blink, and a soft reveal.
Run from any directory; uses only Python's standard library. No runtime synthesis cost.
"""
import json
import math
from pathlib import Path
import random
import struct
import wave

RATE = 22050
DURATION = 3.65
samples = [[0.0, 0.0] for _ in range(round(RATE * DURATION))]
rng = random.Random(27)


def add(start, duration, pitch, end_pitch, gain, pan=0, airy=0.0):
    phase = 0.0
    previous_noise = 0.0
    for frame in range(round(duration * RATE)):
        t = frame / RATE
        x = t / duration
        envelope = math.sin(math.pi * x) ** 2
        frequency = pitch + (end_pitch - pitch) * x
        phase += math.tau * frequency / RATE
        noise = rng.uniform(-1, 1)
        previous_noise = previous_noise * 0.88 + noise * 0.12
        tone = math.sin(phase) + 0.12 * math.sin(phase * 2)
        value = gain * envelope * (tone * (1 - airy) + previous_noise * airy)
        index = round(start * RATE) + frame
        if index >= len(samples):
            break
        samples[index][0] += value * math.sqrt((1 - pan) / 2)
        samples[index][1] += value * math.sqrt((1 + pan) / 2)


# These cues share cornerStarts in StickerLaunchTimeline.
for start, pitch, pan in [(0.30, 260, -0.45), (0.79, 310, 0.45), (1.28, 350, 0.35), (1.77, 390, -0.35)]:
    add(start, 0.48, pitch, pitch * 1.7, 0.16, pan, 0.25)
    add(start + 0.45, 0.10, pitch * 2.1, pitch * 1.2, 0.09, pan)
add(2.46, 0.08, 720, 410, 0.09)
add(2.64, 0.10, 540, 810, 0.08)
add(2.82, 0.66, 420, 840, 0.10, airy=0.7)
add(2.88, 0.58, 660, 660, 0.055)
add(2.94, 0.52, 990, 990, 0.035)

output = Path(__file__).resolve().parents[1] / 'Jiebo/Assets.xcassets/StickerLaunchSound.dataset'
output.mkdir(parents=True, exist_ok=True)
with wave.open(str(output / 'sticker-launch.wav'), 'wb') as audio:
    audio.setnchannels(2)
    audio.setsampwidth(2)
    audio.setframerate(RATE)
    audio.writeframes(b''.join(struct.pack('<hh', *(round(max(-1, min(1, v)) * 32767) for v in sample)) for sample in samples))
(output / 'Contents.json').write_text(json.dumps({
    'data': [{'filename': 'sticker-launch.wav', 'idiom': 'universal'}],
    'info': {'author': 'xcode', 'version': 1}
}, indent=2) + '\n')
print(f'{output / "sticker-launch.wav"}: {DURATION}s, stereo, {RATE}Hz')
