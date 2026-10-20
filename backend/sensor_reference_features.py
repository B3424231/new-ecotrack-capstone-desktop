"""Temperature-only contract shared by NREL training and local inference.

Every feature is an actual present/past temperature, never a pressure, command,
clock-of-day, power target, or state inferred from the target.
"""
import numpy as np

LAGS = (0, 60, 120, 180, 240, 300)
FEATURES = [f'outlet_temperature_lag_{lag}_c' for lag in LAGS]
HISTORY_SECONDS = 300
MAX_CADENCE_SECONDS = 60


def features_for_segment(times, temperatures, cadence, positions=None):
    """As-of actual readings, with no interpolation or future observations.

    Caller splits at faults, timestamp/cadence gaps, boots and calibrations.
    Returns source indices and six recorded temperatures, oldest at lag 300.
    """
    times = np.asarray(times, dtype=float)
    temperatures = np.asarray(temperatures, dtype=float)
    cadence = np.broadcast_to(np.asarray(cadence, dtype=float), times.shape)
    positions = np.arange(len(times)) if positions is None else np.asarray(positions)
    if not len(positions):
        return positions, np.empty((0, len(LAGS)))
    indices = np.searchsorted(times, times[positions, None] - np.asarray(LAGS), side='right') - 1
    safe = np.maximum(indices, 0)
    age = times[positions, None] - np.asarray(LAGS) - times[safe]
    tolerance = np.minimum(1.5 * cadence[safe], MAX_CADENCE_SECONDS)
    good = (indices >= 0).all(axis=1) & (age <= tolerance + 1e-6).all(axis=1)
    good &= (times[positions] - times[0] >= HISTORY_SECONDS)
    values = temperatures[safe]
    good &= np.isfinite(values).all(axis=1)
    return positions[good], values[good]
