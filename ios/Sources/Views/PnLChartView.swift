import SwiftUI
import SwiftData
import Charts

private enum AggregationPeriod: String, CaseIterable, Identifiable {
    case day = "日"
    case week = "週"
    case month = "月"
    case year = "年"

    var id: String { rawValue }

    var calendarComponent: Calendar.Component {
        switch self {
        case .day: return .day
        case .week: return .weekOfYear
        case .month: return .month
        case .year: return .year
        }
    }
}

private struct PnLPoint: Identifiable {
    let id = UUID()
    let periodStart: Date
    let cumulativePnL: Double
}

struct PnLChartView: View {
    @Query private var trades: [Trade]
    @State private var period: AggregationPeriod = .month

    private var lots: [RealizedLot] {
        CostBasisCalculator.calculateAll(trades: trades).lots
    }

    private var points: [PnLPoint] {
        let calendar = Calendar.current
        let sorted = lots.sorted { $0.sellDate < $1.sellDate }
        guard !sorted.isEmpty else { return [] }

        let grouped = Dictionary(grouping: sorted) { lot in
            calendar.dateInterval(of: period.calendarComponent, for: lot.sellDate)?.start ?? lot.sellDate
        }

        var running: Double = 0
        return grouped.keys.sorted().map { key in
            let sum = grouped[key]!.reduce(0) { $0 + $1.realizedPnL }
            running += sum
            return PnLPoint(periodStart: key, cumulativePnL: running)
        }
    }

    var body: some View {
        Group {
            if lots.isEmpty {
                ContentUnavailableView("尚無資料", systemImage: "chart.line.uptrend.xyaxis", description: Text("尚無已實現損益可繪製走勢"))
            } else {
                VStack {
                    Picker("區間", selection: $period) {
                        ForEach(AggregationPeriod.allCases) { Text($0.rawValue).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .padding()

                    Chart(points) { point in
                        LineMark(
                            x: .value("日期", point.periodStart),
                            y: .value("累計損益", point.cumulativePnL)
                        )
                        .interpolationMethod(.monotone)
                        PointMark(
                            x: .value("日期", point.periodStart),
                            y: .value("累計損益", point.cumulativePnL)
                        )
                    }
                    .padding()
                }
            }
        }
        .navigationTitle("損益走勢圖")
    }
}

#Preview {
    NavigationStack { PnLChartView() }
}
