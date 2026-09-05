import SwiftUI
import SwiftData

struct DashboardView: View {
    @Query(sort: \Trade.tradeDate, order: .reverse) private var trades: [Trade]

    private var lots: [RealizedLot] {
        CostBasisCalculator.calculateAll(trades: trades).lots
    }

    private var positions: [Position] {
        CostBasisCalculator.calculateAll(trades: trades).positions
    }

    private var todayRealizedPnL: Double {
        let cal = Calendar.current
        return lots.filter { cal.isDateInToday($0.sellDate) }.reduce(0) { $0 + $1.realizedPnL }
    }

    private var totalRealizedPnL: Double {
        lots.reduce(0) { $0 + $1.realizedPnL }
    }

    var body: some View {
        Group {
            if trades.isEmpty {
                ContentUnavailableView("尚無資料", systemImage: "tray", description: Text("等待與 Firebase 同步交易資料"))
            } else {
                List {
                    Section("損益摘要") {
                        summaryRow(title: "今日已實現損益", value: todayRealizedPnL)
                        summaryRow(title: "累計已實現損益", value: totalRealizedPnL)
                        HStack {
                            Text("持有部位數")
                            Spacer()
                            Text("\(positions.count)")
                                .foregroundStyle(.secondary)
                        }
                    }

                    Section("快速前往") {
                        NavigationLink("持股庫存") { PositionsView() }
                        NavigationLink("已實現損益") { RealizedPnLView() }
                        NavigationLink("損益走勢圖") { PnLChartView() }
                        NavigationLink("提醒") { RemindersView() }
                    }
                }
            }
        }
        .navigationTitle("總覽")
    }

    // NOTE: sums TWD and USD lots together under a TWD label as a simplification;
    // a proper multi-currency dashboard would convert with a live FX rate.
    @ViewBuilder
    private func summaryRow(title: String, value: Double) -> some View {
        HStack {
            Text(title)
            Spacer()
            Text(value, format: .currency(code: "TWD").precision(.fractionLength(0)))
                .foregroundStyle(value >= 0 ? .green : .red)
        }
    }
}

#Preview {
    NavigationStack { DashboardView() }
}
