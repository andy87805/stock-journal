import Foundation

/// Computed on-device from `trades`, never persisted — see CostBasisCalculator.
struct Position: Identifiable, Hashable {
    var id: String { symbol }

    let symbol: String
    let market: String
    let sharesHeld: Double
    let avgCost: Double
    let currency: String

    var costBasisTotal: Double { sharesHeld * avgCost }

    func unrealizedPnL(currentPrice: Double) -> Double {
        (currentPrice - avgCost) * sharesHeld
    }

    func unrealizedPnLPercent(currentPrice: Double) -> Double? {
        guard avgCost != 0 else { return nil }
        return (currentPrice - avgCost) / avgCost
    }
}
