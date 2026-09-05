import SwiftUI
import SwiftData

struct PositionsView: View {
    @Query private var trades: [Trade]

    private let quoteProvider: QuoteProvider = NoopQuoteProvider()
    @State private var livePrices: [String: Double] = [:]

    private var positions: [Position] {
        CostBasisCalculator.calculateAll(trades: trades).positions
    }

    var body: some View {
        Group {
            if positions.isEmpty {
                ContentUnavailableView("尚無持股", systemImage: "briefcase", description: Text("目前沒有庫存部位"))
            } else {
                List(positions) { position in
                    PositionRow(position: position, currentPrice: livePrices[position.symbol])
                }
            }
        }
        .navigationTitle("持股庫存")
        .task {
            await refreshPrices()
        }
    }

    private func refreshPrices() async {
        for position in positions {
            let price = await quoteProvider.currentPrice(symbol: position.symbol, market: position.market)
            if let price {
                livePrices[position.symbol] = price
            }
        }
    }
}

private struct PositionRow: View {
    let position: Position
    let currentPrice: Double?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(position.symbol)
                    .font(.headline)
                Spacer()
                Text("\(position.sharesHeld.formatted()) 股")
                    .foregroundStyle(.secondary)
            }
            HStack {
                Text("均價 \(position.avgCost.formatted())")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                Spacer()
                if let currentPrice {
                    let pnl = position.unrealizedPnL(currentPrice: currentPrice)
                    Text(pnl, format: .currency(code: position.currency).precision(.fractionLength(0)))
                        .foregroundStyle(pnl >= 0 ? .red : .green)
                } else {
                    Text("未實現損益：—")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
            }
        }
        .padding(.vertical, 2)
    }
}

#Preview {
    NavigationStack { PositionsView() }
}
