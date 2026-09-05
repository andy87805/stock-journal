import Foundation
import SwiftData

/// Named to avoid clashing with EventKit's `EKEvent`/`CalendarEvent`-style types.
@Model
final class MarketCalendarEvent {
    @Attribute(.unique) var docId: String

    var symbol: String
    var market: String
    var type: String
    var eventDate: Date
    var note: String?

    init(
        docId: String,
        symbol: String,
        market: String,
        type: String,
        eventDate: Date,
        note: String? = nil
    ) {
        self.docId = docId
        self.symbol = symbol
        self.market = market
        self.type = type
        self.eventDate = eventDate
        self.note = note
    }
}

enum MarketEventType: String {
    case exDividend
    case earnings

    var displayName: String {
        switch self {
        case .exDividend: return "除權息"
        case .earnings: return "財報"
        }
    }
}

extension MarketCalendarEvent {
    var typeEnum: MarketEventType? { MarketEventType(rawValue: type) }
}
