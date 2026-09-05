import Foundation
import SwiftData

@Model
final class Dividend {
    @Attribute(.unique) var docId: String

    var broker: String
    var symbol: String
    var market: String
    var currency: String
    var amount: Double
    var shares: Double?
    var payDate: Date
    var externalId: String
    var syncedAt: Date

    init(
        docId: String,
        broker: String,
        symbol: String,
        market: String,
        currency: String,
        amount: Double,
        shares: Double? = nil,
        payDate: Date,
        externalId: String,
        syncedAt: Date
    ) {
        self.docId = docId
        self.broker = broker
        self.symbol = symbol
        self.market = market
        self.currency = currency
        self.amount = amount
        self.shares = shares
        self.payDate = payDate
        self.externalId = externalId
        self.syncedAt = syncedAt
    }
}
