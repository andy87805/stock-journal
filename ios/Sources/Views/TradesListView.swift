import SwiftUI
import SwiftData

struct TradesListView: View {
    @Query(sort: \Trade.tradeDate, order: .reverse) private var trades: [Trade]

    @State private var brokerFilter: String = "全部"
    @State private var symbolFilter: String = ""

    private var brokers: [String] {
        ["全部"] + Set(trades.map(\.broker)).sorted()
    }

    private var filtered: [Trade] {
        trades.filter { trade in
            (brokerFilter == "全部" || trade.broker == brokerFilter) &&
            (symbolFilter.isEmpty || trade.symbol.localizedCaseInsensitiveContains(symbolFilter))
        }
    }

    var body: some View {
        Group {
            if trades.isEmpty {
                ContentUnavailableView("尚無交易紀錄", systemImage: "list.bullet.rectangle", description: Text("等待與 Firebase 同步交易資料"))
            } else {
                List {
                    ForEach(filtered) { trade in
                        TradeRow(trade: trade)
                    }
                }
                .searchable(text: $symbolFilter, prompt: "搜尋股票代號")
            }
        }
        .navigationTitle("交易紀錄")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Picker("券商", selection: $brokerFilter) {
                        ForEach(brokers, id: \.self) { Text(brokerName($0)).tag($0) }
                    }
                } label: {
                    Label("篩選", systemImage: "line.3.horizontal.decrease.circle")
                }
            }
        }
    }

    private func brokerName(_ raw: String) -> String {
        switch raw {
        case "sinopac": return "永豐金"
        case "schwab": return "嘉信"
        default: return raw
        }
    }
}

private struct TradeRow: View {
    let trade: Trade

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(trade.symbol)
                    .font(.headline)
                Text(trade.sideEnum == .buy ? "買進" : "賣出")
                    .font(.caption)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(trade.sideEnum == .buy ? Color.red.opacity(0.15) : Color.green.opacity(0.15))
                    .foregroundStyle(trade.sideEnum == .buy ? .red : .green)
                    .clipShape(Capsule())
                Spacer()
                Text(trade.tradeDate, format: .dateTime.year().month().day())
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            HStack {
                Text("\(trade.quantity.formatted()) 股 @ \(trade.price.formatted())")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                Spacer()
                Text(trade.grossAmount, format: .currency(code: trade.currency))
                    .font(.subheadline)
            }
            if let note = trade.note, !note.isEmpty {
                Text(note)
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 2)
    }
}

#Preview {
    NavigationStack { TradesListView() }
}
