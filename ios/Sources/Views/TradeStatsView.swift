import SwiftUI
import SwiftData

struct TradeStatsView: View {
    @Query private var trades: [Trade]

    private var lots: [RealizedLot] {
        CostBasisCalculator.calculateAll(trades: trades).lots
    }

    private var winRate: Double? {
        guard !lots.isEmpty else { return nil }
        let wins = lots.filter(\.isWin).count
        return Double(wins) / Double(lots.count)
    }

    private var profitLossRatio: Double? {
        let wins = lots.filter(\.isWin).map(\.realizedPnL)
        let losses = lots.filter { !$0.isWin }.map(\.realizedPnL)
        guard !wins.isEmpty, !losses.isEmpty else { return nil }
        let avgWin = wins.reduce(0, +) / Double(wins.count)
        let avgLoss = abs(losses.reduce(0, +) / Double(losses.count))
        guard avgLoss != 0 else { return nil }
        return avgWin / avgLoss
    }

    private var avgHoldingDays: Double? {
        guard !lots.isEmpty else { return nil }
        return Double(lots.reduce(0) { $0 + $1.holdingDays }) / Double(lots.count)
    }

    var body: some View {
        Group {
            if lots.isEmpty {
                ContentUnavailableView("尚無統計資料", systemImage: "chart.bar", description: Text("需有已實現損益紀錄才能計算統計數據"))
            } else {
                List {
                    Section("整體表現") {
                        statRow(title: "勝率", value: winRate.map { $0.formatted(.percent.precision(.fractionLength(1))) } ?? "—")
                        statRow(title: "盈虧比", value: profitLossRatio.map { $0.formatted(.number.precision(.fractionLength(2))) } ?? "—")
                        statRow(title: "平均持有天數", value: avgHoldingDays.map { "\(Int($0.rounded())) 天" } ?? "—")
                        statRow(title: "已實現交易筆數", value: "\(lots.count)")
                    }
                }
            }
        }
        .navigationTitle("交易統計")
    }

    private func statRow(title: String, value: String) -> some View {
        HStack {
            Text(title)
            Spacer()
            Text(value)
                .foregroundStyle(.secondary)
        }
    }
}

#Preview {
    NavigationStack { TradeStatsView() }
}
