import SwiftUI
import SwiftData
import Charts

private enum ExposureGrouping: String, CaseIterable, Identifiable {
    case symbol = "依股票"
    case sector = "依產業"
    var id: String { rawValue }
}

private struct ExposureSlice: Identifiable {
    let id = UUID()
    let label: String
    let value: Double
}

struct ExposureChartView: View {
    @Query private var trades: [Trade]
    @State private var grouping: ExposureGrouping = .symbol

    private var positions: [Position] {
        CostBasisCalculator.calculateAll(trades: trades).positions
    }

    // NOTE: exposure is measured by cost basis (avgCost * sharesHeld), not live
    // market value, since QuoteProvider has no real implementation yet (see
    // Services/QuoteProvider.swift).
    private var slices: [ExposureSlice] {
        switch grouping {
        case .symbol:
            return positions
                .map { ExposureSlice(label: $0.symbol, value: $0.costBasisTotal) }
                .sorted { $0.value > $1.value }
        case .sector:
            let grouped = Dictionary(grouping: positions) { SectorMap.sector(for: $0.symbol) }
            return grouped.map { key, group in
                ExposureSlice(label: key, value: group.reduce(0) { $0 + $1.costBasisTotal })
            }
            .sorted { $0.value > $1.value }
        }
    }

    var body: some View {
        Group {
            if positions.isEmpty {
                ContentUnavailableView("尚無持股", systemImage: "chart.pie", description: Text("目前沒有庫存部位可計算曝險比例"))
            } else {
                VStack {
                    Picker("分組方式", selection: $grouping) {
                        ForEach(ExposureGrouping.allCases) { Text($0.rawValue).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .padding()

                    Chart(slices) { slice in
                        SectorMark(
                            angle: .value("金額", slice.value),
                            innerRadius: .ratio(0.55),
                            angularInset: 1.5
                        )
                        .foregroundStyle(by: .value("項目", slice.label))
                        .cornerRadius(3)
                    }
                    .padding()

                    List(slices) { slice in
                        HStack {
                            Text(slice.label)
                            Spacer()
                            Text(slice.value, format: .currency(code: "TWD").precision(.fractionLength(0)))
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
        .navigationTitle("曝險比例")
    }
}

#Preview {
    NavigationStack { ExposureChartView() }
}
