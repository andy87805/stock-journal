import SwiftUI
import SwiftData

struct ReportExportView: View {
    @Query private var trades: [Trade]
    @State private var selectedYear: Int
    @State private var exportURL: URL?

    init() {
        _selectedYear = State(initialValue: Calendar.current.component(.year, from: Date()))
    }

    private var lots: [RealizedLot] {
        CostBasisCalculator.calculateAll(trades: trades).lots
    }

    private var availableYears: [Int] {
        let years = Set(lots.map { Calendar.current.component(.year, from: $0.sellDate) })
        let current = Calendar.current.component(.year, from: Date())
        return years.union([current]).sorted(by: >)
    }

    private var lotsForYear: [RealizedLot] {
        lots.filter { Calendar.current.component(.year, from: $0.sellDate) == selectedYear }
            .sorted { $0.sellDate < $1.sellDate }
    }

    var body: some View {
        Form {
            Section("選擇年度") {
                Picker("年度", selection: $selectedYear) {
                    ForEach(availableYears, id: \.self) { year in
                        Text("\(year.formatted(.number.grouping(.never))) 年").tag(year)
                    }
                }
            }

            Section("預覽") {
                if lotsForYear.isEmpty {
                    Text("該年度尚無已實現損益紀錄")
                        .foregroundStyle(.secondary)
                } else {
                    Text("共 \(lotsForYear.count) 筆已實現損益，合計 \(lotsForYear.reduce(0) { $0 + $1.realizedPnL }.formatted(.currency(code: "TWD").precision(.fractionLength(0))))")
                        .foregroundStyle(.secondary)
                }
            }

            Section {
                Button("產生 CSV 檔案") {
                    exportURL = makeCSVFile()
                }
                .disabled(lotsForYear.isEmpty)

                if let exportURL {
                    ShareLink(item: exportURL) {
                        Label("分享 / 儲存 CSV", systemImage: "square.and.arrow.up")
                    }
                }
            }
        }
        .navigationTitle("報表匯出")
    }

    private func makeCSVFile() -> URL? {
        var csv = "symbol,market,sellDate,quantity,proceeds,costBasis,realizedPnL,holdingDays\n"
        let dateFormatter = ISO8601DateFormatter()
        for lot in lotsForYear {
            csv += "\(lot.symbol),\(lot.market),\(dateFormatter.string(from: lot.sellDate)),\(lot.quantity),\(lot.proceeds),\(lot.costBasis),\(lot.realizedPnL),\(lot.holdingDays)\n"
        }

        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("realized_pnl_\(selectedYear)")
            .appendingPathExtension("csv")

        do {
            try csv.write(to: url, atomically: true, encoding: .utf8)
            return url
        } catch {
            print("CSV export failed: \(error.localizedDescription)")
            return nil
        }
    }
}

#Preview {
    NavigationStack { ReportExportView() }
}
