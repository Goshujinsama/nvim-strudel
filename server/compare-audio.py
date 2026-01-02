#!/usr/bin/env python3
"""
Comprehensive Audio Comparison Tool for nvim-strudel

Compares two WAV files (e.g., WebAudio vs SuperCollider renders) with:
- Amplitude analysis (peak, RMS, LUFS-like loudness)
- Automatic alignment (cross-correlation to find optimal offset)
- Envelope comparison (attack, sustain, release characteristics)
- Spectral analysis (frequency content, spectral centroid, bandwidth)
- Transient detection and timing comparison
- Optional visualization output

Usage:
    python compare-audio.py file1.wav file2.wav [options]

Options:
    --align             Auto-align files using cross-correlation
    --trim              Trim longer file to match shorter after alignment
    --normalize         Normalize both files before comparison
    --plot              Generate visualization plots
    --output DIR        Output directory for plots (default: /tmp/audio-compare)
    --verbose           Show detailed analysis output
    --json              Output results as JSON
    --threshold DB      Silence threshold in dB (default: -60)

Requirements:
    pip install numpy scipy soundfile matplotlib

Author: nvim-strudel project
"""

import argparse
import json
import sys
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Optional, Tuple, List, Dict, Any

import numpy as np

try:
    import soundfile as sf
except ImportError:
    print("Error: soundfile not installed. Run: pip install soundfile")
    sys.exit(1)

try:
    from scipy import signal
    from scipy.fft import rfft, rfftfreq
    from scipy.ndimage import uniform_filter1d
except ImportError:
    print("Error: scipy not installed. Run: pip install scipy")
    sys.exit(1)


@dataclass
class AmplitudeStats:
    """Amplitude statistics for an audio file"""

    peak_linear: float
    peak_db: float
    rms_linear: float
    rms_db: float
    crest_factor_db: float  # Peak to RMS ratio
    dynamic_range_db: float  # Difference between loud and quiet parts
    dc_offset: float


@dataclass
class SpectralStats:
    """Spectral characteristics"""

    centroid_hz: float  # "Brightness" - weighted mean frequency
    bandwidth_hz: float  # Spread of frequencies
    rolloff_hz: float  # Frequency below which 85% of energy is contained
    flatness: float  # 0=tonal, 1=noisy (geometric/arithmetic mean ratio)
    dominant_freqs: List[float]  # Top 5 frequency peaks


@dataclass
class EnvelopeStats:
    """Envelope characteristics"""

    attack_time_ms: float  # Time to reach 90% of peak
    decay_time_ms: float  # Time from peak to sustain level
    sustain_level: float  # Average level during sustain (0-1)
    release_time_ms: float  # Time from sustain to silence


@dataclass
class TimingStats:
    """Timing and transient analysis"""

    first_transient_ms: float  # Time to first significant sound
    num_transients: int  # Number of detected transients/onsets
    transient_times_ms: List[float]  # Times of detected transients


@dataclass
class ComparisonResult:
    """Complete comparison results"""

    file1: str
    file2: str
    sample_rate: int
    duration1_s: float
    duration2_s: float

    # Alignment
    aligned: bool
    alignment_offset_ms: float
    alignment_correlation: float

    # Per-file stats
    amplitude1: AmplitudeStats
    amplitude2: AmplitudeStats
    spectral1: SpectralStats
    spectral2: SpectralStats
    timing1: TimingStats
    timing2: TimingStats

    # Differences
    peak_diff_db: float
    rms_diff_db: float
    spectral_centroid_diff_hz: float
    waveform_correlation: float
    envelope_correlation: float
    spectral_correlation: float

    # Overall similarity score (0-100)
    similarity_score: float

    # Issues detected
    issues: List[str]


def load_audio(path: str) -> Tuple[np.ndarray, int]:
    """Load audio file, convert to mono float32"""
    data, sr = sf.read(path, dtype="float32")

    # Convert to mono if stereo
    if len(data.shape) > 1:
        data = np.mean(data, axis=1)

    return data, sr


def resample_if_needed(data: np.ndarray, sr_orig: int, sr_target: int) -> np.ndarray:
    """Resample audio if sample rates differ"""
    if sr_orig == sr_target:
        return data

    # Calculate new length
    duration = len(data) / sr_orig
    new_length = int(duration * sr_target)

    # Use scipy resample
    return signal.resample(data, new_length)


def find_first_transient(
    data: np.ndarray, sample_rate: int, threshold_db: float = -40
) -> int:
    """Find the sample index of the first transient above threshold."""
    threshold_linear = 10 ** (threshold_db / 20)
    above = np.where(np.abs(data) > threshold_linear)[0]
    return int(above[0]) if len(above) > 0 else 0


def find_alignment_offset_by_transient(
    ref: np.ndarray,
    target: np.ndarray,
    sample_rate: int = 48000,
    threshold_db: float = -40,
) -> Tuple[int, float]:
    """
    Find alignment offset by matching first transients.
    More reliable than cross-correlation for different audio engines.
    Returns (offset_samples, confidence).
    Positive offset means skip that many samples from target.
    """
    first_ref = find_first_transient(ref, sample_rate, threshold_db)
    first_target = find_first_transient(target, sample_rate, threshold_db)

    offset = first_target - first_ref

    # Confidence based on how well-defined the transients are
    # (higher confidence if transients are clearly above threshold)
    threshold_linear = 10 ** (threshold_db / 20)
    ref_peak = (
        np.max(np.abs(ref[:sample_rate]))
        if len(ref) > sample_rate
        else np.max(np.abs(ref))
    )
    target_peak = (
        np.max(np.abs(target[:sample_rate]))
        if len(target) > sample_rate
        else np.max(np.abs(target))
    )
    confidence = (
        min(ref_peak / threshold_linear, target_peak / threshold_linear, 10.0) / 10.0
    )

    return offset, float(confidence)


def find_alignment_offset(
    ref: np.ndarray,
    target: np.ndarray,
    max_offset_ms: float = 500,
    sample_rate: int = 48000,
) -> Tuple[int, float]:
    """
    Find optimal alignment offset using cross-correlation.
    Returns (offset_samples, correlation_coefficient).
    Positive offset means target should be shifted right (delayed).
    """
    max_offset_samples = int(max_offset_ms * sample_rate / 1000)

    # Use shorter segments for efficiency (first 2 seconds)
    max_len = min(len(ref), len(target), sample_rate * 2)
    ref_seg = ref[:max_len]
    target_seg = target[:max_len]

    # Compute cross-correlation
    correlation = signal.correlate(ref_seg, target_seg, mode="full")

    # Find the peak
    center = len(target_seg) - 1
    search_start = max(0, center - max_offset_samples)
    search_end = min(len(correlation), center + max_offset_samples)

    search_region = correlation[search_start:search_end]
    peak_idx = np.argmax(np.abs(search_region))

    # Calculate offset (positive = target is delayed relative to ref)
    offset = (search_start + peak_idx) - center

    # Calculate normalized correlation at peak
    peak_corr = correlation[search_start + peak_idx]
    norm_factor = np.sqrt(np.sum(ref_seg**2) * np.sum(target_seg**2))
    if norm_factor > 0:
        corr_coef = peak_corr / norm_factor
    else:
        corr_coef = 0.0

    return offset, float(corr_coef)


def align_audio(
    ref: np.ndarray, target: np.ndarray, offset: int
) -> Tuple[np.ndarray, np.ndarray]:
    """
    Align two audio arrays based on calculated offset.
    Returns trimmed arrays of equal length.
    """
    if offset > 0:
        # Target is delayed, shift it left (remove from start)
        target = target[offset:]
    elif offset < 0:
        # Target is early, shift it right (remove from ref start)
        ref = ref[-offset:]

    # Trim to same length
    min_len = min(len(ref), len(target))
    return ref[:min_len], target[:min_len]


def calculate_amplitude_stats(
    data: np.ndarray, sample_rate: int, silence_threshold_db: float = -60
) -> AmplitudeStats:
    """Calculate amplitude statistics"""
    # Peak
    peak = np.max(np.abs(data))
    peak_db = 20 * np.log10(max(peak, 1e-10))

    # RMS
    rms = np.sqrt(np.mean(data**2))
    rms_db = 20 * np.log10(max(rms, 1e-10))

    # Crest factor
    crest_db = peak_db - rms_db

    # DC offset
    dc_offset = np.mean(data)

    # Dynamic range (RMS of loud vs quiet sections)
    # Split into 100ms windows and find range
    window_size = int(0.1 * sample_rate)
    if len(data) >= window_size:
        num_windows = len(data) // window_size
        window_rms = []
        for i in range(num_windows):
            window = data[i * window_size : (i + 1) * window_size]
            w_rms = np.sqrt(np.mean(window**2))
            if w_rms > 10 ** (silence_threshold_db / 20):
                window_rms.append(w_rms)

        if len(window_rms) >= 2:
            loud = np.percentile(window_rms, 90)
            quiet = np.percentile(window_rms, 10)
            dynamic_range = 20 * np.log10(max(loud, 1e-10) / max(quiet, 1e-10))
        else:
            dynamic_range = 0.0
    else:
        dynamic_range = 0.0

    return AmplitudeStats(
        peak_linear=float(peak),
        peak_db=float(peak_db),
        rms_linear=float(rms),
        rms_db=float(rms_db),
        crest_factor_db=float(crest_db),
        dynamic_range_db=float(dynamic_range),
        dc_offset=float(dc_offset),
    )


def calculate_spectral_stats(data: np.ndarray, sample_rate: int) -> SpectralStats:
    """Calculate spectral characteristics using FFT"""
    # Use a representative segment (middle portion, avoid transients)
    segment_len = min(len(data), sample_rate * 2)  # 2 seconds max
    start = (len(data) - segment_len) // 2
    segment = data[start : start + segment_len]

    # Apply window
    window = np.hanning(len(segment))
    windowed = segment * window

    # FFT
    spectrum = np.abs(rfft(windowed))
    freqs = rfftfreq(len(windowed), 1 / sample_rate)

    # Avoid DC
    spectrum = spectrum[1:]
    freqs = freqs[1:]

    # Power spectrum
    power = spectrum**2
    total_power = np.sum(power)

    if total_power < 1e-10:
        return SpectralStats(
            centroid_hz=0, bandwidth_hz=0, rolloff_hz=0, flatness=0, dominant_freqs=[]
        )

    # Spectral centroid (weighted mean frequency)
    centroid = np.sum(freqs * power) / total_power

    # Spectral bandwidth (weighted std dev)
    bandwidth = np.sqrt(np.sum(((freqs - centroid) ** 2) * power) / total_power)

    # Spectral rolloff (frequency below which 85% of power)
    cumsum = np.cumsum(power)
    rolloff_idx = np.searchsorted(cumsum, 0.85 * total_power)
    rolloff = freqs[min(rolloff_idx, len(freqs) - 1)]

    # Spectral flatness (geometric mean / arithmetic mean)
    log_spectrum = np.log(spectrum + 1e-10)
    geometric_mean = np.exp(np.mean(log_spectrum))
    arithmetic_mean = np.mean(spectrum)
    flatness = geometric_mean / (arithmetic_mean + 1e-10)

    # Find dominant frequencies (peaks)
    peak_indices, _ = signal.find_peaks(spectrum, height=np.max(spectrum) * 0.1)
    peak_freqs = freqs[peak_indices]
    peak_mags = spectrum[peak_indices]

    # Sort by magnitude, take top 5
    sorted_idx = np.argsort(peak_mags)[::-1][:5]
    dominant_freqs = [float(peak_freqs[i]) for i in sorted_idx if i < len(peak_freqs)]

    return SpectralStats(
        centroid_hz=float(centroid),
        bandwidth_hz=float(bandwidth),
        rolloff_hz=float(rolloff),
        flatness=float(flatness),
        dominant_freqs=dominant_freqs,
    )


def calculate_envelope(
    data: np.ndarray, sample_rate: int, window_ms: float = 10
) -> np.ndarray:
    """Extract amplitude envelope using peak detection"""
    window_samples = int(window_ms * sample_rate / 1000)

    # Take absolute value
    abs_data = np.abs(data)

    # Use maximum filter for peak envelope
    from scipy.ndimage import maximum_filter1d

    envelope = maximum_filter1d(abs_data, size=window_samples)

    # Smooth with uniform filter
    envelope = uniform_filter1d(envelope, size=window_samples)

    # Downsample to window rate
    downsample = window_samples
    envelope = envelope[::downsample]

    return envelope


def calculate_envelope_stats(
    data: np.ndarray, sample_rate: int, silence_threshold_db: float = -60
) -> EnvelopeStats:
    """Analyze envelope characteristics"""
    envelope = calculate_envelope(data, sample_rate, window_ms=5)
    env_sr = sample_rate / (5 * sample_rate / 1000)  # Envelope sample rate

    if len(envelope) == 0 or np.max(envelope) < 1e-10:
        return EnvelopeStats(
            attack_time_ms=0, decay_time_ms=0, sustain_level=0, release_time_ms=0
        )

    # Normalize envelope
    peak = np.max(envelope)
    norm_env = envelope / peak

    # Find attack time (time to reach 90% of peak)
    peak_idx = np.argmax(norm_env)
    attack_threshold = 0.9
    attack_indices = np.where(norm_env[:peak_idx] < attack_threshold)[0]
    if len(attack_indices) > 0:
        attack_start = attack_indices[-1]
        attack_time_ms = (peak_idx - attack_start) * 5  # 5ms windows
    else:
        attack_time_ms = peak_idx * 5

    # Find sustain level (average of middle 50%)
    if len(norm_env) > 4:
        quarter = len(norm_env) // 4
        sustain_region = norm_env[quarter : 3 * quarter]
        sustain_level = float(np.mean(sustain_region))
    else:
        sustain_level = float(np.mean(norm_env))

    # Find release time (time from sustain to silence)
    silence_linear = 10 ** (silence_threshold_db / 20)
    release_threshold = max(silence_linear / peak, 0.01)

    # Look for end of sound
    below_threshold = np.where(norm_env < release_threshold)[0]
    if len(below_threshold) > 0:
        # Find last continuous silent region
        sound_end = below_threshold[0]
        for i in range(len(below_threshold) - 1):
            if below_threshold[i + 1] - below_threshold[i] > 1:
                sound_end = below_threshold[i + 1]

        if sound_end > peak_idx:
            release_time_ms = (sound_end - peak_idx) * 5
        else:
            release_time_ms = 0
    else:
        release_time_ms = (len(norm_env) - peak_idx) * 5

    # Decay time (from peak to sustain level)
    if sustain_level < 0.9:
        decay_indices = np.where(norm_env[peak_idx:] < sustain_level + 0.1)[0]
        if len(decay_indices) > 0:
            decay_time_ms = decay_indices[0] * 5
        else:
            decay_time_ms = 0
    else:
        decay_time_ms = 0

    return EnvelopeStats(
        attack_time_ms=float(attack_time_ms),
        decay_time_ms=float(decay_time_ms),
        sustain_level=float(sustain_level),
        release_time_ms=float(release_time_ms),
    )


def detect_transients(
    data: np.ndarray, sample_rate: int, threshold_db: float = -40
) -> TimingStats:
    """Detect transients/onsets in audio"""
    # Calculate onset strength using spectral flux
    hop_length = int(0.01 * sample_rate)  # 10ms hops
    window_length = int(0.025 * sample_rate)  # 25ms windows

    # Simple energy-based onset detection
    num_frames = (len(data) - window_length) // hop_length + 1
    if num_frames <= 0:
        return TimingStats(
            first_transient_ms=0, num_transients=0, transient_times_ms=[]
        )

    # Calculate frame energies
    energies = np.zeros(num_frames)
    for i in range(num_frames):
        start = i * hop_length
        frame = data[start : start + window_length]
        energies[i] = np.sum(frame**2)

    # Calculate onset strength (positive energy differences)
    onset_strength = np.diff(energies)
    onset_strength = np.maximum(onset_strength, 0)

    # Normalize
    if np.max(onset_strength) > 0:
        onset_strength = onset_strength / np.max(onset_strength)

    # Find peaks
    threshold_linear = 10 ** (threshold_db / 20)
    min_distance = int(0.05 * sample_rate / hop_length)  # 50ms minimum between onsets

    peaks, _ = signal.find_peaks(
        onset_strength, height=0.1, distance=max(1, min_distance)
    )

    # Convert to milliseconds
    transient_times_ms = [(p * hop_length / sample_rate) * 1000 for p in peaks]

    # Find first transient above threshold
    abs_data = np.abs(data)
    first_above = np.where(abs_data > threshold_linear)[0]
    if len(first_above) > 0:
        first_transient_ms = (first_above[0] / sample_rate) * 1000
    else:
        first_transient_ms = 0

    return TimingStats(
        first_transient_ms=float(first_transient_ms),
        num_transients=len(peaks),
        transient_times_ms=transient_times_ms[:20],  # Limit to first 20
    )


def calculate_correlation(a: np.ndarray, b: np.ndarray) -> float:
    """Calculate Pearson correlation coefficient.

    Measures how well the shapes match (slope/direction of change).
    Two flat signals will have high correlation because they have
    identical slopes (zero) at every point.
    """
    if len(a) != len(b):
        min_len = min(len(a), len(b))
        a = a[:min_len]
        b = b[:min_len]

    if len(a) == 0:
        return 0.0

    a_mean = np.mean(a)
    b_mean = np.mean(b)

    a_centered = a - a_mean
    b_centered = b - b_mean

    a_var = np.sum(a_centered**2)
    b_var = np.sum(b_centered**2)

    den = np.sqrt(a_var * b_var)

    # Only guard against numerical issues (division by zero)
    # If both have zero variance, they're identical shapes (both flat) = correlation 1.0
    if den < 1e-10:
        # Check if both are flat (both have ~zero variance)
        if a_var < 1e-10 and b_var < 1e-10:
            return 1.0
        # One is flat, one varies - undefined, but effectively uncorrelated
        return 0.0

    num = np.sum(a_centered * b_centered)
    return float(num / den)


def calculate_waveform_shape_similarity(
    data1: np.ndarray, data2: np.ndarray, sample_rate: int
) -> float:
    """
    Calculate phase-agnostic waveform shape similarity.

    Instead of comparing sample-by-sample (which fails if oscillators are out of phase),
    we compare the statistical properties of individual cycles:
    - Peak-to-peak amplitude
    - Zero-crossing period (fundamental frequency)
    - Slope distribution at multiple points per cycle

    A sine wave looks like a sine wave regardless of starting phase.
    """
    # Use a segment from the middle (avoid attack/release transients)
    segment_len = min(len(data1), len(data2), sample_rate)  # 1 second max
    start1 = (len(data1) - segment_len) // 2
    start2 = (len(data2) - segment_len) // 2
    seg1 = data1[start1 : start1 + segment_len]
    seg2 = data2[start2 : start2 + segment_len]

    scores = []

    # 1. Peak-to-peak amplitude comparison
    pp1 = np.max(seg1) - np.min(seg1)
    pp2 = np.max(seg2) - np.min(seg2)
    if pp1 > 1e-10 and pp2 > 1e-10:
        pp_ratio = min(pp1, pp2) / max(pp1, pp2)
        scores.append(pp_ratio)

    # 2. Zero-crossing rate (indicates fundamental frequency)
    def zero_crossing_rate(x):
        return np.sum(np.abs(np.diff(np.signbit(x)))) / len(x)

    zcr1 = zero_crossing_rate(seg1)
    zcr2 = zero_crossing_rate(seg2)
    if zcr1 > 1e-10 and zcr2 > 1e-10:
        zcr_ratio = min(zcr1, zcr2) / max(zcr1, zcr2)
        scores.append(zcr_ratio)

    # 3. RMS comparison (overall energy)
    rms1 = np.sqrt(np.mean(seg1**2))
    rms2 = np.sqrt(np.mean(seg2**2))
    if rms1 > 1e-10 and rms2 > 1e-10:
        rms_ratio = min(rms1, rms2) / max(rms1, rms2)
        scores.append(rms_ratio)

    # 4. Slope histogram comparison
    # Calculate instantaneous slopes and compare their distributions
    slopes1 = np.diff(seg1) * sample_rate  # Scale to per-second
    slopes2 = np.diff(seg2) * sample_rate

    # Normalize slopes by peak-to-peak to make comparison scale-independent
    if pp1 > 1e-10:
        slopes1 = slopes1 / pp1
    if pp2 > 1e-10:
        slopes2 = slopes2 / pp2

    # Compare slope histograms using correlation
    n_bins = 50
    slope_range = max(np.abs(slopes1).max(), np.abs(slopes2).max(), 1e-10)
    bins = np.linspace(-slope_range, slope_range, n_bins + 1)

    hist1, _ = np.histogram(slopes1, bins=bins, density=True)
    hist2, _ = np.histogram(slopes2, bins=bins, density=True)

    # Correlation of slope histograms
    if np.sum(hist1) > 0 and np.sum(hist2) > 0:
        slope_corr = calculate_correlation(hist1, hist2)
        scores.append(max(0, slope_corr))

    # 5. Amplitude histogram comparison (waveform shape signature)
    # A sine wave has a specific amplitude distribution, sawtooth has another
    amp_range = max(np.abs(seg1).max(), np.abs(seg2).max(), 1e-10)
    amp_bins = np.linspace(-amp_range, amp_range, n_bins + 1)

    amp_hist1, _ = np.histogram(seg1, bins=amp_bins, density=True)
    amp_hist2, _ = np.histogram(seg2, bins=amp_bins, density=True)

    if np.sum(amp_hist1) > 0 and np.sum(amp_hist2) > 0:
        amp_corr = calculate_correlation(amp_hist1, amp_hist2)
        scores.append(max(0, amp_corr))

    # 6. Crest factor comparison (peak/RMS ratio - characterizes waveform shape)
    if rms1 > 1e-10 and rms2 > 1e-10:
        crest1 = np.max(np.abs(seg1)) / rms1
        crest2 = np.max(np.abs(seg2)) / rms2
        crest_ratio = min(crest1, crest2) / max(crest1, crest2)
        scores.append(crest_ratio)

    if len(scores) == 0:
        return 0.0

    return float(np.mean(scores))


def calculate_spectral_correlation(
    data1: np.ndarray, data2: np.ndarray, sample_rate: int
) -> float:
    """Calculate correlation between magnitude spectra"""
    # Ensure same length
    min_len = min(len(data1), len(data2))

    # Use 1 second segments
    segment_len = min(min_len, sample_rate)

    # Get magnitude spectra
    spec1 = np.abs(rfft(data1[:segment_len]))
    spec2 = np.abs(rfft(data2[:segment_len]))

    return calculate_correlation(spec1, spec2)


def calculate_similarity_score(result: "ComparisonResult") -> float:
    """
    Calculate overall similarity score (0-100).
    Weights different aspects based on perceptual importance.

    For synthesis comparison (different audio engines), spectral match is most important
    since oscillator phase will never be identical between implementations.
    """
    scores = []
    weights = []

    # Spectral correlation (most important for timbre matching between different engines)
    # This measures if both produce the same frequencies at similar levels
    scores.append(max(0, result.spectral_correlation) * 100)
    weights.append(5.0)

    # RMS difference (loudness match) - very important for perceived similarity
    # 0 dB diff = 100, 3 dB diff = 50, 6+ dB diff = 0
    rms_score = max(0, 100 - abs(result.rms_diff_db) * (100 / 6))
    scores.append(rms_score)
    weights.append(3.0)

    # Envelope correlation (important for dynamics, but less so for steady-state tones)
    scores.append(max(0, result.envelope_correlation) * 100)
    weights.append(1.5)

    # Waveform shape similarity (phase-agnostic comparison)
    scores.append(max(0, result.waveform_correlation) * 100)
    weights.append(1.0)

    # Peak difference (transients can vary, less important than RMS)
    # 0 dB diff = 100, 6 dB diff = 50, 12+ dB diff = 0
    peak_score = max(0, 100 - abs(result.peak_diff_db) * (100 / 12))
    scores.append(peak_score)
    weights.append(0.5)

    # Spectral centroid difference (timbre)
    # 0 Hz diff = 100, 500 Hz diff = 50, 1000+ Hz diff = 0
    centroid_score = max(0, 100 - abs(result.spectral_centroid_diff_hz) * (100 / 1000))
    scores.append(centroid_score)
    weights.append(1.0)

    # Alignment quality (if aligned)
    if result.aligned:
        align_score = max(0, result.alignment_correlation) * 100
        scores.append(align_score)
        weights.append(0.5)

    # Weighted average
    total_weight = sum(weights)
    weighted_sum = sum(s * w for s, w in zip(scores, weights))

    return weighted_sum / total_weight


def detect_issues(result: "ComparisonResult") -> List[str]:
    """Detect potential issues between the two files"""
    issues = []

    # Check amplitude differences
    if abs(result.peak_diff_db) > 3:
        issues.append(f"Peak level differs by {result.peak_diff_db:.1f} dB")

    if abs(result.rms_diff_db) > 3:
        issues.append(f"RMS level differs by {result.rms_diff_db:.1f} dB")

    # Check timing - after alignment, the initial offset is corrected.
    # What matters is if the timing DRIFTS (e.g., different tempo).
    # The alignment_offset_ms is just informational, not an issue.
    # We detect drift by comparing transient timing on the ALIGNED audio
    # (which would show if peaks diverge over time).
    # Note: timing1/timing2 are calculated on original audio, so transient
    # timing diff is only meaningful if we didn't align, or for drift detection.

    # Check spectral content
    if abs(result.spectral_centroid_diff_hz) > 200:
        issues.append(
            f"Spectral centroid differs by {result.spectral_centroid_diff_hz:.0f} Hz (timbre difference)"
        )

    # Check correlation
    if result.waveform_correlation < 0.8:
        issues.append(
            f"Low waveform correlation ({result.waveform_correlation:.2f}) - different audio content"
        )

    if result.spectral_correlation < 0.9:
        issues.append(
            f"Low spectral correlation ({result.spectral_correlation:.2f}) - frequency content differs"
        )

    # Check for DC offset
    if abs(result.amplitude1.dc_offset) > 0.01:
        issues.append(f"File 1 has DC offset: {result.amplitude1.dc_offset:.4f}")
    if abs(result.amplitude2.dc_offset) > 0.01:
        issues.append(f"File 2 has DC offset: {result.amplitude2.dc_offset:.4f}")

    return issues


def compare_audio(
    file1: str,
    file2: str,
    align: bool = True,
    trim: bool = False,
    normalize: bool = False,
    silence_threshold_db: float = -60,
) -> ComparisonResult:
    """
    Perform comprehensive comparison of two audio files.
    """
    # Load files
    data1, sr1 = load_audio(file1)
    data2, sr2 = load_audio(file2)

    # Resample if needed (to higher rate)
    target_sr = max(sr1, sr2)
    if sr1 != target_sr:
        data1 = resample_if_needed(data1, sr1, target_sr)
    if sr2 != target_sr:
        data2 = resample_if_needed(data2, sr2, target_sr)

    duration1 = len(data1) / target_sr
    duration2 = len(data2) / target_sr

    # Alignment
    if align:
        # Use transient-based alignment (more reliable for different audio engines)
        # Use -40dB threshold for transient detection - this catches the actual
        # start of sound rather than very quiet pre-roll which may differ between backends
        offset, align_corr = find_alignment_offset_by_transient(
            data1, data2, sample_rate=target_sr, threshold_db=-40
        )
        offset_ms = (offset / target_sr) * 1000

        # Apply alignment: skip 'offset' samples from the file that starts later
        if offset > 0:
            # target (data2) starts later, skip from its start
            data2_aligned = data2[offset:]
            data1_aligned = data1
        elif offset < 0:
            # ref (data1) starts later, skip from its start
            data1_aligned = data1[-offset:]
            data2_aligned = data2
        else:
            data1_aligned = data1
            data2_aligned = data2

        # Trim to same length
        min_len = min(len(data1_aligned), len(data2_aligned))
        data1_aligned = data1_aligned[:min_len]
        data2_aligned = data2_aligned[:min_len]

        # If trim is requested, use file1's original length as the target
        if trim:
            target_len = len(data1)
            if offset > 0:
                # data2 was shifted, trim both to target_len
                data1_aligned = data1_aligned[:target_len]
                data2_aligned = data2_aligned[:target_len]
                # Update data2 for per-file stats
                data2 = data2[offset : offset + target_len]
            else:
                data1_aligned = data1_aligned[:target_len]
                data2_aligned = data2_aligned[:target_len]
            duration2 = len(data2) / target_sr
    else:
        offset_ms = 0
        align_corr = 0
        min_len = min(len(data1), len(data2))
        data1_aligned = data1[:min_len]
        data2_aligned = data2[:min_len]

    # Normalize if requested
    if normalize:
        peak1 = np.max(np.abs(data1_aligned))
        peak2 = np.max(np.abs(data2_aligned))
        if peak1 > 1e-10:
            data1_aligned = data1_aligned / peak1
        if peak2 > 1e-10:
            data2_aligned = data2_aligned / peak2

    # Calculate per-file statistics
    amp1 = calculate_amplitude_stats(data1, target_sr, silence_threshold_db)
    amp2 = calculate_amplitude_stats(data2, target_sr, silence_threshold_db)

    spec1 = calculate_spectral_stats(data1, target_sr)
    spec2 = calculate_spectral_stats(data2, target_sr)

    timing1 = detect_transients(data1, target_sr, silence_threshold_db)
    timing2 = detect_transients(data2, target_sr, silence_threshold_db)

    # Calculate correlations on aligned data
    # Use phase-agnostic waveform shape comparison since different audio engines
    # will never have phase-locked oscillators. What matters is that the waveform
    # SHAPE is the same (same slopes, same amplitude distribution, same period).
    waveform_corr = calculate_waveform_shape_similarity(
        data1_aligned, data2_aligned, target_sr
    )

    env1 = calculate_envelope(data1_aligned, target_sr)
    env2 = calculate_envelope(data2_aligned, target_sr)

    # For envelope correlation, we care about the SHAPE of the envelope (attack, sustain, release)
    # not the absolute level (which is captured by RMS comparison).
    # Normalize envelopes to their respective peaks to compare shape.
    # Also, steady-state oscillators will have fairly flat envelopes, so we focus on
    # whether both have similar dynamics (flat vs. changing).
    if np.max(env1) > 1e-10 and np.max(env2) > 1e-10:
        env1_norm = env1 / np.max(env1)
        env2_norm = env2 / np.max(env2)
        envelope_corr = calculate_correlation(env1_norm, env2_norm)

        # If both envelopes are relatively flat (low variance), treat as matching
        # since two sustained tones should match regardless of correlation quirks
        env1_var = np.var(env1_norm)
        env2_var = np.var(env2_norm)
        if env1_var < 0.01 and env2_var < 0.01:
            # Both are flat (sustained sounds) - that's a match
            envelope_corr = max(envelope_corr, 0.9)
    else:
        envelope_corr = 0.0

    spectral_corr = calculate_spectral_correlation(
        data1_aligned, data2_aligned, target_sr
    )

    # Calculate envelope stats on original (non-normalized) data
    env_stats1 = calculate_envelope_stats(data1, target_sr, silence_threshold_db)
    env_stats2 = calculate_envelope_stats(data2, target_sr, silence_threshold_db)

    # Build result
    result = ComparisonResult(
        file1=file1,
        file2=file2,
        sample_rate=target_sr,
        duration1_s=duration1,
        duration2_s=duration2,
        aligned=align,
        alignment_offset_ms=offset_ms,
        alignment_correlation=align_corr,
        amplitude1=amp1,
        amplitude2=amp2,
        spectral1=spec1,
        spectral2=spec2,
        timing1=timing1,
        timing2=timing2,
        peak_diff_db=amp2.peak_db - amp1.peak_db,
        rms_diff_db=amp2.rms_db - amp1.rms_db,
        spectral_centroid_diff_hz=spec2.centroid_hz - spec1.centroid_hz,
        waveform_correlation=waveform_corr,
        envelope_correlation=envelope_corr,
        spectral_correlation=spectral_corr,
        similarity_score=0,  # Calculated below
        issues=[],  # Filled below
    )

    result.similarity_score = calculate_similarity_score(result)
    result.issues = detect_issues(result)

    return result


def generate_plots(
    result: ComparisonResult,
    data1: np.ndarray,
    data2: np.ndarray,
    sample_rate: int,
    output_dir: str,
):
    """Generate visualization plots"""
    try:
        import matplotlib.pyplot as plt
        import matplotlib

        matplotlib.use("Agg")  # Non-interactive backend
    except ImportError:
        print("Warning: matplotlib not installed, skipping plots")
        return

    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    # Time axis
    time1 = np.arange(len(data1)) / sample_rate
    time2 = np.arange(len(data2)) / sample_rate

    fig, axes = plt.subplots(4, 1, figsize=(12, 10))

    # 1. Waveform comparison
    ax = axes[0]
    ax.plot(time1, data1, alpha=0.7, label=f"File 1", linewidth=0.5)
    ax.plot(time2, data2, alpha=0.7, label=f"File 2", linewidth=0.5)
    ax.set_xlabel("Time (s)")
    ax.set_ylabel("Amplitude")
    ax.set_title("Waveform Comparison")
    ax.legend()
    ax.grid(True, alpha=0.3)

    # 2. Envelope comparison
    ax = axes[1]
    env1 = calculate_envelope(data1, sample_rate, window_ms=20)
    env2 = calculate_envelope(data2, sample_rate, window_ms=20)
    time_env = np.arange(len(env1)) * 0.02  # 20ms windows
    ax.plot(time_env[: len(env1)], env1, label="File 1", linewidth=1)
    ax.plot(time_env[: len(env2)], env2, label="File 2", linewidth=1)
    ax.set_xlabel("Time (s)")
    ax.set_ylabel("Envelope")
    ax.set_title("Amplitude Envelope")
    ax.legend()
    ax.grid(True, alpha=0.3)

    # 3. Spectrum comparison
    ax = axes[2]
    # Take middle 1 second
    seg_len = min(len(data1), len(data2), sample_rate)
    start1 = (len(data1) - seg_len) // 2
    start2 = (len(data2) - seg_len) // 2

    spec1 = np.abs(rfft(data1[start1 : start1 + seg_len] * np.hanning(seg_len)))
    spec2 = np.abs(rfft(data2[start2 : start2 + seg_len] * np.hanning(seg_len)))
    freqs = rfftfreq(seg_len, 1 / sample_rate)

    # Convert to dB
    spec1_db = 20 * np.log10(spec1 + 1e-10)
    spec2_db = 20 * np.log10(spec2 + 1e-10)

    ax.semilogx(freqs[1:], spec1_db[1:], label="File 1", alpha=0.7, linewidth=0.5)
    ax.semilogx(freqs[1:], spec2_db[1:], label="File 2", alpha=0.7, linewidth=0.5)
    ax.set_xlabel("Frequency (Hz)")
    ax.set_ylabel("Magnitude (dB)")
    ax.set_title("Frequency Spectrum")
    ax.set_xlim(20, sample_rate / 2)
    ax.legend()
    ax.grid(True, alpha=0.3)

    # 4. Difference
    ax = axes[3]
    min_len = min(len(data1), len(data2))
    diff = data1[:min_len] - data2[:min_len]
    time_diff = np.arange(min_len) / sample_rate
    ax.plot(time_diff, diff, linewidth=0.5, color="red")
    ax.set_xlabel("Time (s)")
    ax.set_ylabel("Difference")
    ax.set_title(f"Waveform Difference (RMS: {np.sqrt(np.mean(diff**2)):.4f})")
    ax.grid(True, alpha=0.3)

    plt.tight_layout()
    plot_path = output_path / "comparison.png"
    plt.savefig(plot_path, dpi=150)
    plt.close()

    print(f"Plot saved to: {plot_path}")


def print_report(result: ComparisonResult, verbose: bool = False):
    """Print human-readable comparison report"""
    print("\n" + "=" * 60)
    print("AUDIO COMPARISON REPORT")
    print("=" * 60)

    print(f"\nFile 1: {result.file1}")
    print(f"File 2: {result.file2}")
    print(f"\nSample Rate: {result.sample_rate} Hz")
    print(f"Duration: {result.duration1_s:.2f}s vs {result.duration2_s:.2f}s")

    if result.aligned:
        print(f"\n--- Alignment ---")
        print(f"Offset: {result.alignment_offset_ms:.1f} ms")
        print(f"Correlation: {result.alignment_correlation:.4f}")

    print(f"\n--- Amplitude ---")
    print(f"{'':20} {'File 1':>12} {'File 2':>12} {'Diff':>12}")
    print(
        f"{'Peak (dB)':20} {result.amplitude1.peak_db:>12.1f} {result.amplitude2.peak_db:>12.1f} {result.peak_diff_db:>+12.1f}"
    )
    print(
        f"{'RMS (dB)':20} {result.amplitude1.rms_db:>12.1f} {result.amplitude2.rms_db:>12.1f} {result.rms_diff_db:>+12.1f}"
    )
    print(
        f"{'Crest Factor (dB)':20} {result.amplitude1.crest_factor_db:>12.1f} {result.amplitude2.crest_factor_db:>12.1f}"
    )
    print(
        f"{'Dynamic Range (dB)':20} {result.amplitude1.dynamic_range_db:>12.1f} {result.amplitude2.dynamic_range_db:>12.1f}"
    )

    print(f"\n--- Spectral ---")
    print(f"{'':20} {'File 1':>12} {'File 2':>12} {'Diff':>12}")
    print(
        f"{'Centroid (Hz)':20} {result.spectral1.centroid_hz:>12.0f} {result.spectral2.centroid_hz:>12.0f} {result.spectral_centroid_diff_hz:>+12.0f}"
    )
    print(
        f"{'Bandwidth (Hz)':20} {result.spectral1.bandwidth_hz:>12.0f} {result.spectral2.bandwidth_hz:>12.0f}"
    )
    print(
        f"{'Rolloff (Hz)':20} {result.spectral1.rolloff_hz:>12.0f} {result.spectral2.rolloff_hz:>12.0f}"
    )
    print(
        f"{'Flatness':20} {result.spectral1.flatness:>12.4f} {result.spectral2.flatness:>12.4f}"
    )

    print(f"\n--- Timing ---")
    print(f"{'':20} {'File 1':>12} {'File 2':>12}")
    print(
        f"{'First Transient (ms)':20} {result.timing1.first_transient_ms:>12.1f} {result.timing2.first_transient_ms:>12.1f}"
    )
    print(
        f"{'Num Transients':20} {result.timing1.num_transients:>12} {result.timing2.num_transients:>12}"
    )

    print(f"\n--- Correlation ---")
    print(
        f"Waveform:  {result.waveform_correlation:>8.4f}  {'Excellent' if result.waveform_correlation > 0.95 else 'Good' if result.waveform_correlation > 0.8 else 'Fair' if result.waveform_correlation > 0.5 else 'Poor'}"
    )
    print(
        f"Envelope:  {result.envelope_correlation:>8.4f}  {'Excellent' if result.envelope_correlation > 0.95 else 'Good' if result.envelope_correlation > 0.8 else 'Fair' if result.envelope_correlation > 0.5 else 'Poor'}"
    )
    print(
        f"Spectral:  {result.spectral_correlation:>8.4f}  {'Excellent' if result.spectral_correlation > 0.95 else 'Good' if result.spectral_correlation > 0.8 else 'Fair' if result.spectral_correlation > 0.5 else 'Poor'}"
    )

    print(f"\n--- Overall ---")
    score = result.similarity_score
    rating = (
        "Identical"
        if score > 95
        else "Very Similar"
        if score > 85
        else "Similar"
        if score > 70
        else "Different"
        if score > 50
        else "Very Different"
    )
    print(f"Similarity Score: {score:.1f}/100 ({rating})")

    if result.issues:
        print(f"\n--- Issues Detected ---")
        for issue in result.issues:
            print(f"  - {issue}")
    else:
        print(f"\n  No significant issues detected.")

    if verbose:
        print(f"\n--- Detailed Stats ---")
        print(f"File 1 DC Offset: {result.amplitude1.dc_offset:.6f}")
        print(f"File 2 DC Offset: {result.amplitude2.dc_offset:.6f}")
        if result.spectral1.dominant_freqs:
            print(
                f"File 1 Dominant Frequencies: {', '.join(f'{f:.0f}Hz' for f in result.spectral1.dominant_freqs[:5])}"
            )
        if result.spectral2.dominant_freqs:
            print(
                f"File 2 Dominant Frequencies: {', '.join(f'{f:.0f}Hz' for f in result.spectral2.dominant_freqs[:5])}"
            )

    print("\n" + "=" * 60)


def main():
    parser = argparse.ArgumentParser(
        description="Comprehensive audio comparison tool",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python compare-audio.py render1.wav render2.wav
  python compare-audio.py webaudio.wav superdirt.wav --align --normalize --plot
  python compare-audio.py a.wav b.wav --json > results.json
        """,
    )

    parser.add_argument("file1", help="First audio file")
    parser.add_argument("file2", help="Second audio file")
    parser.add_argument(
        "--align", action="store_true", help="Auto-align files using cross-correlation"
    )
    parser.add_argument(
        "--trim",
        action="store_true",
        help="Trim file2 to match file1's duration after alignment",
    )
    parser.add_argument(
        "--normalize",
        action="store_true",
        help="Normalize both files before comparison",
    )
    parser.add_argument(
        "--plot", action="store_true", help="Generate visualization plots"
    )
    parser.add_argument(
        "--output", default="/tmp/audio-compare", help="Output directory for plots"
    )
    parser.add_argument(
        "--verbose", "-v", action="store_true", help="Show detailed analysis"
    )
    parser.add_argument("--json", action="store_true", help="Output results as JSON")
    parser.add_argument(
        "--threshold",
        type=float,
        default=-60,
        help="Silence threshold in dB (default: -60)",
    )

    args = parser.parse_args()

    # Validate files exist
    for f in [args.file1, args.file2]:
        if not Path(f).exists():
            print(f"Error: File not found: {f}")
            sys.exit(1)

    # Run comparison
    result = compare_audio(
        args.file1,
        args.file2,
        align=args.align,
        trim=args.trim,
        normalize=args.normalize,
        silence_threshold_db=args.threshold,
    )

    # Output results
    if args.json:
        # Convert to JSON-serializable dict
        result_dict = asdict(result)
        print(json.dumps(result_dict, indent=2))
    else:
        print_report(result, verbose=args.verbose)

    # Generate plots if requested
    if args.plot:
        data1, sr1 = load_audio(args.file1)
        data2, sr2 = load_audio(args.file2)
        target_sr = max(sr1, sr2)
        if sr1 != target_sr:
            data1 = resample_if_needed(data1, sr1, target_sr)
        if sr2 != target_sr:
            data2 = resample_if_needed(data2, sr2, target_sr)

        generate_plots(result, data1, data2, target_sr, args.output)

    # Return exit code based on similarity
    if result.similarity_score < 50:
        sys.exit(2)  # Very different
    elif result.similarity_score < 80:
        sys.exit(1)  # Somewhat different
    else:
        sys.exit(0)  # Similar enough


if __name__ == "__main__":
    main()
