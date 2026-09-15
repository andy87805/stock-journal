"""Daily valuation snapshots. Same Taiwan date is replaced, not duplicated."""
import json
import subprocess
from datetime import datetime, timezone, timedelta
from pathlib import Path


def main():
    from firestore_client import init_firestore, all_user_roots
    db = init_firestore()
    quotes = {d.id: d.to_dict() for d in db.collection("quotes").stream()}
    fx = db.collection("fx").document("USDTWD").get().to_dict()
    count = 0
    for root in all_user_roots(db):
        # Do not save a known partially-imported or partially-undone portfolio.
        if any(d.to_dict().get("status") in {"running", "interrupted", "undoing", "undo_partial"}
               for d in root.collection("importRuns").stream()):
            print("Snapshot skipped: unresolved import state (user details omitted)")
            continue
        payload = {name: [d.to_dict() for d in root.collection(name).stream()]
                   for name in ("positions", "trades", "options")}
        payload["cashBalance"] = root.collection("settings").document("cashBalance").get().to_dict()
        if not any(payload.values()):
            continue
        payload["personalQuotes"] = {d.id: d.to_dict() for d in root.collection("quotes").stream()}
        payload.update(quotes=quotes, fx=fx)
        result = subprocess.run(["node", str(Path(__file__).with_name("value_snapshot.mjs"))],
                                input=json.dumps(payload, default=lambda v: v.isoformat()),
                                capture_output=True, text=True, encoding="utf-8", timeout=60)
        if result.returncode:
            raise RuntimeError("Snapshot valuation failed; private data omitted")
        snapshot = json.loads(result.stdout)
        day = datetime.fromisoformat(snapshot["capturedAt"].replace("Z", "+00:00")).astimezone(
            timezone(timedelta(hours=8))).date().isoformat()
        snapshot["date"] = day
        root.collection("assetSnapshots").document(day).set(snapshot)
        count += 1
    print(f"Snapshots saved for {count} users; values not logged")


if __name__ == "__main__":
    main()
