"""Pure synthetic checks; no Firebase, broker login, email or network."""
import ast
import pathlib
import unittest
from datetime import date, datetime, timedelta
from types import SimpleNamespace

ROOT = pathlib.Path(__file__).resolve().parents[1]

def functions(path, names):
    tree = ast.parse((ROOT / path).read_text(encoding="utf-8-sig"))
    tree.body = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
    namespace = dict(date=date, datetime=datetime, timedelta=timedelta, MARKET="TW", CURRENCY="TWD", WINDOW_DAYS=364)
    exec(compile(tree, path, "exec"), namespace)
    return namespace

class SyncTests(unittest.TestCase):
    def setUp(self):
        self.ns = functions("sync/shioaji_sync.py", {"_f", "_date_str", "build_positions", "weighted_entry_date", "_build_realized_window", "build_realized"})

    def test_missing_position_details_stop_update(self):
        api = SimpleNamespace(
            list_positions=lambda account, **kwargs: [SimpleNamespace(code="TEST", price=100, pnl=20, id=1)],
            list_position_detail=lambda account, id: [],
        )
        with self.assertRaises(RuntimeError):
            self.ns["build_positions"](api, None)

    def test_missing_realized_details_stop_update(self):
        api = SimpleNamespace(
            list_profit_loss=lambda *args: [SimpleNamespace(code="TEST", date="2026-01-01", dseq="test", id=1)],
            list_profit_loss_detail=lambda *args: [],
        )
        with self.assertRaises(RuntimeError):
            self.ns["_build_realized_window"](api, None, date(2026, 1, 1), date(2026, 1, 2))

    def test_pending_zero_cost_does_not_stop_other_positions(self):
        api = SimpleNamespace(
            list_positions=lambda account, **kwargs: [SimpleNamespace(code="PENDING", price=0, pnl=0, id=0), SimpleNamespace(code="OK", price=100, pnl=20, id=1)],
            list_position_detail=lambda account, id: [SimpleNamespace(price=0 if id == 0 else 1000, date="2026-01-01")],
        )
        positions, _, _ = self.ns["build_positions"](api, None)
        self.assertIsNone(positions[0]["totalCost"])
        self.assertIsNone(positions[0]["unrealizedPnl"])
        self.assertEqual(positions[1]["totalCost"], 1000)

    def test_undated_position_preserves_cost_and_unknown_date(self):
        api = SimpleNamespace(
            list_positions=lambda account, **kwargs: [SimpleNamespace(code="TEST", price=100, pnl=20, id=1)],
            list_position_detail=lambda *args: [SimpleNamespace(price=1000, date=None)],
        )
        positions, quotes, lots = self.ns["build_positions"](api, None)
        self.assertEqual(positions[0]["totalCost"], 1000)
        self.assertIsNone(lots[0]["tradeDate"])

    def test_date_windows_cover_final_day_without_overlap(self):
        windows = []
        self.ns["_build_realized_window"] = lambda api, account, start, end: (windows.append((start, end)) or ([], []))
        start, end = date(2024, 1, 1), date(2026, 1, 1)
        self.ns["build_realized"](None, None, start, end)
        self.assertEqual(windows[0][0], start)
        self.assertEqual(windows[-1][1], end)
        for left, right in zip(windows, windows[1:]):
            self.assertEqual(left[1] + timedelta(days=1), right[0])

    def test_share_unit_preserves_odd_lots_without_cost_inference(self):
        def positions(account, unit):
            self.assertEqual(unit, "Share")
            return [SimpleNamespace(code="TEST", quantity=51, price=99.99, id=1)]
        api = SimpleNamespace(list_positions=positions,
            list_position_detail=lambda *args: [SimpleNamespace(price=5000, date="2026-01-01")])
        rows, _, _ = self.ns["build_positions"](api, None)
        self.assertEqual(rows[0]["shares"], 51)
        self.assertEqual(rows[0]["lots"], 0.051)

if __name__ == "__main__":
    unittest.main()
