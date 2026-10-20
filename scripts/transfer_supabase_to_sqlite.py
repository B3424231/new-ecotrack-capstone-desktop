"""Catch up local telemetry using the backend's validated cloud ingestion pipeline."""
import importlib.util
from pathlib import Path


def transfer():
    source = Path(__file__).resolve().parents[1] / 'backend/app.py'
    spec = importlib.util.spec_from_file_location('ecotrack_transfer_backend', source)
    backend = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(backend)
    fetched = transferred = 0
    while True:
        result = backend.sync_cloud_telemetry_once()
        fetched += result['fetched']
        transferred += result['transferred']
        if result['fetched'] < 500:
            break
    print(f'Telemetry catch-up complete: {fetched} fetched, {transferred} inserted.')
    return {'fetched': fetched, 'transferred': transferred}


if __name__ == '__main__':
    transfer()
