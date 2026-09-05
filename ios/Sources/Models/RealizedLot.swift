import Foundation

/// One closed (sell) transaction's realized result, computed on-device — see CostBasisCalculator.
struct RealizedLot: Identifiable, Hashable {
    var id: String { "\(symbol)_\(sellDate.timeIntervalSince1970)_\(quantity)" }

    let symbol: String
    let market: String
    let sellDate: Date
    let quantity: Double
    let proceeds: Double
    let costBasis: Double
    let realizedPnL: Double
    let holdingDays: Int

    var realizedPnLPercent: Double? {
        guard costBasis != 0 else { return nil }
        return realizedPnL / costBasis
    }

    var isWin: Bool { realizedPnL > 0 }
}
