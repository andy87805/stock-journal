import SwiftUI
import SwiftData

struct RealizedPnLView: View {
    @Query private var trades: [Trade]

    private var lots: [RealizedLot] {
        CostBasisCalculator.calculateAll(trades: trades).lots
    }

    var body: some View {
        Group {
            if lots.isEmpty {
                ContentUnavailableView("尚無已實現損益", systemImage: "checkmark.seal", description: Text("賣出交易後會在此顯示已實現損益"))
            } else {
                List(lots) { lot in
                    LotRow(lot: lot)
                }
            }
        }
        .navigationTitle("已實現損益")
    }
}

private struct LotRow: View {
    let lot: RealizedLot

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(lot.symbol)
                    .font(.headline)
                Spacer()
                Text(lot.sellDate, format: .dateTime.year().month().day())
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            HStack {
                Text("成本 \(lot.costBasis.formatted()) → 賣出 \(lot.proceeds.formatted())")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                Spacer()
                Text(lot.realizedPnL, format: .currency(code: "TWD").precision(.fractionLength(0)))
                    .foregroundStyle(lot.isWin ? .red : .green)
            }
            HStack(spacing: 12) {
                Text("持有 \(lot.holdingDays) 天")
                if let pct = lot.realizedPnLPercent {
                    Text(pct, format: .percent.precision(.fractionLength(1)))
                        .foregroundStyle(lot.isWin ? .red : .green)
                }
            }
            .font(.caption)
            .foregroundStyle(.tertiary)
        }
        .padding(.vertical, 2)
    }
}

#Preview {
    NavigationStack { RealizedPnLView() }
}
