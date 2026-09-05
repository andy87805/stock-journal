import SwiftUI
import SwiftData

struct DividendsView: View {
    @Query(sort: \Dividend.payDate, order: .reverse) private var dividends: [Dividend]

    private var yearlyTotals: [(year: Int, total: Double)] {
        let calendar = Calendar.current
        let grouped = Dictionary(grouping: dividends) { calendar.component(.year, from: $0.payDate) }
        return grouped.map { (year: $0.key, total: $0.value.reduce(0) { $0 + $1.amount }) }
            .sorted { $0.year > $1.year }
    }

    var body: some View {
        Group {
            if dividends.isEmpty {
                ContentUnavailableView("尚無股利紀錄", systemImage: "banknote", description: Text("等待與 Firebase 同步股利資料"))
            } else {
                List {
                    Section("年度總計") {
                        ForEach(yearlyTotals, id: \.year) { entry in
                            HStack {
                                Text("\(entry.year.formatted(.number.grouping(.never))) 年")
                                Spacer()
                                Text(entry.total, format: .currency(code: "TWD").precision(.fractionLength(0)))
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }

                    Section("明細") {
                        ForEach(dividends) { dividend in
                            DividendRow(dividend: dividend)
                        }
                    }
                }
            }
        }
        .navigationTitle("股利紀錄")
    }
}

private struct DividendRow: View {
    let dividend: Dividend

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(dividend.symbol)
                    .font(.headline)
                Spacer()
                Text(dividend.payDate, format: .dateTime.year().month().day())
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            HStack {
                if let shares = dividend.shares {
                    Text("持股 \(shares.formatted()) 股")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Text(dividend.amount, format: .currency(code: dividend.currency))
            }
        }
        .padding(.vertical, 2)
    }
}

#Preview {
    NavigationStack { DividendsView() }
}
