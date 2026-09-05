import Foundation

/// Moving-average cost method (移動平均法), matching what SCHEMA.md mandates since
/// `trades` is the only source of truth and Firestore stores no derived positions.
///
/// Holding-days approximation: a position's "entry date" is reset to the trade date
/// whenever shares go from 0 -> >0 (a fresh position opened from flat). Adding more
/// shares to an already-open position does NOT move the entry date forward — so
/// holding days for a sell is simply (sellDate - dateThePositionWasLastOpenedFromZero).
/// This under-counts true weighted-average entry time when a position is built up in
/// multiple buys over a long span, but is simple, deterministic, and good enough for
/// a personal journal's "average holding days" stat.
enum CostBasisCalculator {

    static func calculate(tradesForSymbol trades: [Trade]) -> (position: Position?, lots: [RealizedLot]) {
        guard let first = trades.first else { return (nil, []) }
        let sorted = trades.sorted { $0.tradeDate < $1.tradeDate }

        var sharesHeld: Double = 0
        var avgCost: Double = 0
        var positionOpenedDate: Date?
        var lots: [RealizedLot] = []

        for trade in sorted {
            switch trade.sideEnum {
            case .buy:
                let totalCostBefore = avgCost * sharesHeld
                let thisCost = trade.quantity * trade.price + trade.fee
                let newShares = sharesHeld + trade.quantity
                if newShares > 0 {
                    avgCost = (totalCostBefore + thisCost) / newShares
                }
                if sharesHeld <= 0 {
                    positionOpenedDate = trade.tradeDate
                }
                sharesHeld = newShares

            case .sell:
                let sellQty = min(trade.quantity, sharesHeld)
                guard sellQty > 0 else { continue }

                let proceeds = sellQty * trade.price - trade.fee - trade.tax
                let costBasis = sellQty * avgCost
                let realizedPnL = proceeds - costBasis
                let holdingDays: Int
                if let opened = positionOpenedDate {
                    holdingDays = max(0, Calendar.current.dateComponents([.day], from: opened, to: trade.tradeDate).day ?? 0)
                } else {
                    holdingDays = 0
                }

                lots.append(RealizedLot(
                    symbol: trade.symbol,
                    market: trade.market,
                    sellDate: trade.tradeDate,
                    quantity: sellQty,
                    proceeds: proceeds,
                    costBasis: costBasis,
                    realizedPnL: realizedPnL,
                    holdingDays: holdingDays
                ))

                sharesHeld -= sellQty
                if sharesHeld <= 0 {
                    sharesHeld = 0
                    positionOpenedDate = nil
                }

            case .none:
                continue
            }
        }

        let position: Position?
        if sharesHeld > 0.0001 {
            position = Position(
                symbol: first.symbol,
                market: first.market,
                sharesHeld: sharesHeld,
                avgCost: avgCost,
                currency: first.currency
            )
        } else {
            position = nil
        }

        return (position, lots)
    }

    static func calculateAll(trades: [Trade]) -> (positions: [Position], lots: [RealizedLot]) {
        let bySymbol = Dictionary(grouping: trades, by: \.symbol)
        var positions: [Position] = []
        var allLots: [RealizedLot] = []

        for (_, symbolTrades) in bySymbol {
            let (position, lots) = calculate(tradesForSymbol: symbolTrades)
            if let position { positions.append(position) }
            allLots.append(contentsOf: lots)
        }

        positions.sort { $0.symbol < $1.symbol }
        allLots.sort { $0.sellDate > $1.sellDate }
        return (positions, allLots)
    }
}
