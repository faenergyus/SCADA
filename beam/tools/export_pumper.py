"""Export FAE Pumper Data wells (with lat/long, type, status) to pumper_wells.json.

Source: sf\\sqldev .. Ops_Reporting .. dbo.Pumper_Data_Calcs (959 rows)
Output: C:\\AI\\CLAUDE\\SCADA\\beam\\data\\pumper_wells.json

Run on demand or schedule hourly. Data is mostly static (type/status changes
infrequently); no need for the 4-minute cadence used by SCADA exports.
"""
from __future__ import annotations

import json
import sys
from datetime import datetime
from pathlib import Path

import pyodbc

CONN_STR = (
    r"DRIVER={ODBC Driver 17 for SQL Server};"
    r"SERVER=sf\sqldev;"
    r"DATABASE=Ops_Reporting;"
    r"Trusted_Connection=yes;"
    r"TrustServerCertificate=yes;"
)
OUT_PATH = Path(r"C:\AI\CLAUDE\SCADA\beam\data\pumper_wells.json")

# Sanity bounds for lat/long (Permian basin / NM-TX).
# Anything outside is treated as missing.
LAT_MIN, LAT_MAX = 30.0, 36.0
LNG_MIN, LNG_MAX = -106.0, -100.0


def main() -> None:
    conn = pyodbc.connect(CONN_STR, timeout=30)
    cur = conn.cursor()
    cur.execute(
        """
        SELECT [Short Name], [Well Name], [API10 (String)], Lat, Long,
               [Type], [Status], Area, Route, [Pumper Name], Engineer,
               Unit, Location, Company, _LeaseType, [WBD Link]
        FROM dbo.Pumper_Data_Calcs
        WHERE Lat IS NOT NULL AND Long IS NOT NULL
        """
    )
    cols = [d[0] for d in cur.description]
    wells: list[dict] = []
    skipped = 0
    for row in cur.fetchall():
        rec = dict(zip(cols, row))
        try:
            lat = float(rec["Lat"])
            lng = float(rec["Long"])
        except (TypeError, ValueError):
            skipped += 1
            continue
        if not (LAT_MIN <= lat <= LAT_MAX and LNG_MIN <= lng <= LNG_MAX):
            skipped += 1
            continue
        wells.append({
            "sn":     (rec["Short Name"] or "").strip(),
            "name":   (rec["Well Name"]  or "").strip(),
            "api":    str(rec["API10 (String)"] or ""),
            "lat":    round(lat, 6),
            "lng":    round(lng, 6),
            "type":   (rec["Type"]   or "").strip() or None,
            "status": (rec["Status"] or "").strip() or None,
            "area":   (rec["Area"]   or "").strip() or None,
            "route":  (rec["Route"]  or "").strip() or None,
            "pumper": (rec["Pumper Name"] or "").strip() or None,
            "engr":   (rec["Engineer"] or "").strip() or None,
            "unit":   (rec["Unit"]    or "").strip() or None,
            "loc":    (rec["Location"] or "").strip() or None,
            "co":     (rec["Company"] or "").strip() or None,
            "lt":     (rec["_LeaseType"] or "").strip() or None,
            "wbd":    (rec["WBD Link"] or "").strip() or None,
        })
    conn.close()

    out = {
        "_meta": {
            "exported_at": datetime.now().isoformat(timespec="seconds"),
            "row_count":   len(wells),
            "skipped_no_coords": skipped,
            "source":      "sf\\sqldev / Ops_Reporting / dbo.Pumper_Data_Calcs",
        },
        "wells": wells,
    }
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    # Quick stats to stderr
    print(f"Wrote {OUT_PATH}", file=sys.stderr)
    print(f"  {len(wells)} wells  ({skipped} skipped — bad/missing coords)", file=sys.stderr)
    type_counts: dict[str, int] = {}
    for w in wells:
        t = w["type"] or "(none)"
        type_counts[t] = type_counts.get(t, 0) + 1
    for t, n in sorted(type_counts.items(), key=lambda x: -x[1]):
        print(f"    {n:>4}  {t}", file=sys.stderr)


if __name__ == "__main__":
    main()
