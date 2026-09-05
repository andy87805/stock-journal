import Foundation
import SwiftData

@Model
final class Trade {
    @Attribute(.unique) var docId: String

    var broker: String
    var symbol: String
    var market: String
    var side: String
    var quantity: Double
    var price: Double
    var fee: Double
    var tax: Double
    var currency: String
    var tradeDate: Date
    var externalId: String
    var note: String?
    var syncedAt: Date

    init(
        docId: String,
        broker: String,
        symbol: String,
        market: String,
        side: String,
        quantity: Double,
        price: Double,
        fee: Double,
        tax: Double,
        currency: String,
        tradeDate: Date,
        externalId: String,
        note: String? = nil,
        syncedAt: Date
    ) {
        self.docId = docId
        self.broker = broker
        self.symbol = symbol
        self.market = market
        self.side = side
        self.quantity = quantity
        self.price = price
        self.fee = fee
        self.tax = tax
        self.currency = currency
        self.tradeDate = tradeDate
        self.externalId = externalId
        self.note = note
        self.syncedAt = syncedAt
    }
}

enum Broker: String {
    case sinopac
    case schwab
}

enum Market: String {
    case tw = "TW"
    case us = "US"
}

enum TradeSide: String {
    case buy
    case sell
}

extension Trade {
    var brokerEnum: Broker? { Broker(rawValue: broker) }
    var marketEnum: Market? { Market(rawValue: market) }
    var sideEnum: TradeSide? { TradeSide(rawValue: side) }

    var grossAmount: Double { quantity * price }

    /// Net cash effect of this trade: buys cost cash (fee added), sells return cash (fee+tax subtracted).
    var netCashFlow: Double {
        switch sideEnum {
        case .buy: return -(grossAmount + fee)
        case .sell: return grossAmount - fee - tax
        case .none: return 0
        }
    }
}
