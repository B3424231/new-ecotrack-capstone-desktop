"""Inspect isolated future-cost exports. Never reads live telemetry or configuration."""
import json
import subprocess
import sys
from pathlib import Path

import pdfplumber
from openpyxl import load_workbook
from pypdf import PdfReader

folder = Path(__file__).resolve().parents[1] / "reports" / "future-cost"
checks = []
for source in ("controller", "sensor"):
    for scenario in ("future", "empty-history-future"):
        filename = folder / f"{source}-{scenario}.pdf"
        reader = PdfReader(filename)
        texts = [page.extract_text() or "" for page in reader.pages]
        first = next(i for i, text in enumerate(texts) if "Future Cost Projection" in text)
        future = "\n".join(texts[first:])
        assert f"Future Cost Projection - {source.title()}" in future
        assert "Future Cost - AC Inputs and Coverage" in future
        assert "Future Cost - Daily Breakdown" in future
        assert "Planned AC unit-hours" in future
        assert "TOTAL" in future
        if scenario == "future":
            assert "2026-10-21 to 2026-10-27" in future
            assert "56" in future
        else:
            assert "2026-11-01 to 2026-11-30" in future
            assert "2026-11-30" in future
        if source == "sensor":
            assert "XGBoost" in future
            assert "Histogram Gradient Boosting" not in future
            assert "Controller Fixture" not in future
            assert "future temperatures and consumption are not forecast" in future
            if scenario == "empty-history-future":
                assert "Predicted energy (kWh) Unavailable" in future
                assert "Estimated cost (PHP) Unavailable" in future
            else:
                assert "20.5036" in future
                assert "271.47" in future
        else:
            assert "Histogram Gradient Boosting" in future
            assert "Target: 24 C" in future
            assert "Fan: medium" in future
            assert "planned hours do not confirm future AC operation" in future
            assert "{\"setpoint" not in future
        with pdfplumber.open(filename) as pdf:
            for page in pdf.pages[first:]:
                assert all(5 < char["x0"] < char["x1"] < page.width - 5
                           and 5 < char["top"] < char["bottom"] < page.height - 5
                           for char in page.chars if char["text"].strip()), filename
        for index in (first, first + 1, first + 2):
            subprocess.run([sys.argv[1], "-f", str(index+1), "-l", str(index+1),
                            "-r", "100", "-png", "-singlefile", str(filename),
                            str(folder / f"{source}-{scenario}-page-{index+1}")], check=True,
                           capture_output=True)
        (folder / f"{source}-{scenario}.txt").write_text("\n".join(texts), encoding="utf-8")
        checks.append({"file": filename.name, "status": "PASS", "pages": len(texts),
                       "future_starts_at": first+1, "text_bounds": "PASS"})
    workbook = load_workbook(folder / f"{source}-history.xlsx", data_only=True)
    cells = " ".join(str(cell.value) for sheet in workbook for row in sheet for cell in row)
    assert "Future Cost" not in cells
    assert "2026-10-21" not in cells
    assert "2026-11-01" not in cells
    assert len(workbook.worksheets) == 2
    checks.append({"file": f"{source}-history.xlsx", "status": "PASS",
                   "contents": "Historical source data only; future plan excluded"})
(folder / "pdf-excel-verification.json").write_text(json.dumps(checks, indent=2))
print("PASS four PDFs: model/source separation, future periods, null data, totals, text bounds; two historical Excel exports")
