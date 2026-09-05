import Foundation
import SwiftData
import FirebaseFirestore

@MainActor
final class FirestoreSync {
    private let db = Firestore.firestore()
    private var listeners: [ListenerRegistration] = []

    private(set) var lastSyncAt: [String: Date] = [:]
    private(set) var lastSuccess: [String: Bool] = [:]

    private let isoFormatter = ISO8601DateFormatter()

    func startListening(modelContext: ModelContext) {
        stopListening()

        listeners.append(
            db.collection("trades").addSnapshotListener { [weak self] snapshot, _ in
                self?.applyTrades(snapshot, modelContext: modelContext)
            }
        )
        listeners.append(
            db.collection("dividends").addSnapshotListener { [weak self] snapshot, _ in
                self?.applyDividends(snapshot, modelContext: modelContext)
            }
        )
        listeners.append(
            db.collection("calendarEvents").addSnapshotListener { [weak self] snapshot, _ in
                self?.applyCalendarEvents(snapshot, modelContext: modelContext)
            }
        )

        Task { await loadSyncMeta() }
    }

    func stopListening() {
        listeners.forEach { $0.remove() }
        listeners.removeAll()
    }

    private func loadSyncMeta() async {
        guard let snapshot = try? await db.collection("syncMeta").getDocuments() else { return }
        for doc in snapshot.documents {
            let data = doc.data()
            if let s = data["lastSyncAt"] as? String, let date = isoFormatter.date(from: s) {
                lastSyncAt[doc.documentID] = date
            }
            lastSuccess[doc.documentID] = data["lastSuccess"] as? Bool ?? false
        }
    }

    private func applyTrades(_ snapshot: QuerySnapshot?, modelContext: ModelContext) {
        guard let snapshot else { return }
        for change in snapshot.documentChanges {
            let docId = change.document.documentID
            switch change.type {
            case .added, .modified:
                let data = change.document.data()
                upsertTrade(docId: docId, data: data, modelContext: modelContext)
            case .removed:
                deleteModel(Trade.self, docId: docId, modelContext: modelContext)
            }
        }
        try? modelContext.save()
    }

    private func applyDividends(_ snapshot: QuerySnapshot?, modelContext: ModelContext) {
        guard let snapshot else { return }
        for change in snapshot.documentChanges {
            let docId = change.document.documentID
            switch change.type {
            case .added, .modified:
                let data = change.document.data()
                upsertDividend(docId: docId, data: data, modelContext: modelContext)
            case .removed:
                deleteModel(Dividend.self, docId: docId, modelContext: modelContext)
            }
        }
        try? modelContext.save()
    }

    private func applyCalendarEvents(_ snapshot: QuerySnapshot?, modelContext: ModelContext) {
        guard let snapshot else { return }
        for change in snapshot.documentChanges {
            let docId = change.document.documentID
            switch change.type {
            case .added, .modified:
                let data = change.document.data()
                upsertCalendarEvent(docId: docId, data: data, modelContext: modelContext)
            case .removed:
                deleteModel(MarketCalendarEvent.self, docId: docId, modelContext: modelContext)
            }
        }
        try? modelContext.save()
    }

    private func upsertTrade(docId: String, data: [String: Any], modelContext: ModelContext) {
        guard
            let broker = data["broker"] as? String,
            let symbol = data["symbol"] as? String,
            let market = data["market"] as? String,
            let side = data["side"] as? String,
            let quantity = data["quantity"] as? Double,
            let price = data["price"] as? Double,
            let currency = data["currency"] as? String,
            let tradeDateStr = data["tradeDate"] as? String,
            let tradeDate = isoFormatter.date(from: tradeDateStr),
            let externalId = data["externalId"] as? String
        else { return }

        let fee = data["fee"] as? Double ?? 0
        let tax = data["tax"] as? Double ?? 0
        let note = data["note"] as? String
        let syncedAt = (data["syncedAt"] as? String).flatMap { isoFormatter.date(from: $0) } ?? Date()

        let existing = fetchTrade(docId: docId, modelContext: modelContext)
        let trade = existing ?? Trade(
            docId: docId, broker: broker, symbol: symbol, market: market, side: side,
            quantity: quantity, price: price, fee: fee, tax: tax, currency: currency,
            tradeDate: tradeDate, externalId: externalId, note: note, syncedAt: syncedAt
        )
        if existing != nil {
            trade.broker = broker
            trade.symbol = symbol
            trade.market = market
            trade.side = side
            trade.quantity = quantity
            trade.price = price
            trade.fee = fee
            trade.tax = tax
            trade.currency = currency
            trade.tradeDate = tradeDate
            trade.externalId = externalId
            // NOTE: `note` is user-editable on-device; sync scripts never write it
            // (see SCHEMA.md), so we intentionally do not overwrite it here either
            // unless Firestore actually carries a non-nil value.
            if note != nil { trade.note = note }
            trade.syncedAt = syncedAt
        } else {
            modelContext.insert(trade)
        }
    }

    private func upsertDividend(docId: String, data: [String: Any], modelContext: ModelContext) {
        guard
            let broker = data["broker"] as? String,
            let symbol = data["symbol"] as? String,
            let market = data["market"] as? String,
            let currency = data["currency"] as? String,
            let amount = data["amount"] as? Double,
            let payDateStr = data["payDate"] as? String,
            let payDate = isoFormatter.date(from: payDateStr),
            let externalId = data["externalId"] as? String
        else { return }

        let shares = data["shares"] as? Double
        let syncedAt = (data["syncedAt"] as? String).flatMap { isoFormatter.date(from: $0) } ?? Date()

        let existing = fetchDividend(docId: docId, modelContext: modelContext)
        let dividend = existing ?? Dividend(
            docId: docId, broker: broker, symbol: symbol, market: market, currency: currency,
            amount: amount, shares: shares, payDate: payDate, externalId: externalId, syncedAt: syncedAt
        )
        if existing != nil {
            dividend.broker = broker
            dividend.symbol = symbol
            dividend.market = market
            dividend.currency = currency
            dividend.amount = amount
            dividend.shares = shares
            dividend.payDate = payDate
            dividend.externalId = externalId
            dividend.syncedAt = syncedAt
        } else {
            modelContext.insert(dividend)
        }
    }

    private func upsertCalendarEvent(docId: String, data: [String: Any], modelContext: ModelContext) {
        guard
            let symbol = data["symbol"] as? String,
            let market = data["market"] as? String,
            let type = data["type"] as? String,
            let eventDateStr = data["eventDate"] as? String,
            let eventDate = isoFormatter.date(from: eventDateStr)
        else { return }

        let note = data["note"] as? String

        let existing = fetchCalendarEvent(docId: docId, modelContext: modelContext)
        let event = existing ?? MarketCalendarEvent(
            docId: docId, symbol: symbol, market: market, type: type, eventDate: eventDate, note: note
        )
        if existing != nil {
            event.symbol = symbol
            event.market = market
            event.type = type
            event.eventDate = eventDate
            event.note = note
        } else {
            modelContext.insert(event)
        }
    }

    private func fetchTrade(docId: String, modelContext: ModelContext) -> Trade? {
        var descriptor = FetchDescriptor<Trade>(predicate: #Predicate { $0.docId == docId })
        descriptor.fetchLimit = 1
        return try? modelContext.fetch(descriptor).first
    }

    private func fetchDividend(docId: String, modelContext: ModelContext) -> Dividend? {
        var descriptor = FetchDescriptor<Dividend>(predicate: #Predicate { $0.docId == docId })
        descriptor.fetchLimit = 1
        return try? modelContext.fetch(descriptor).first
    }

    private func fetchCalendarEvent(docId: String, modelContext: ModelContext) -> MarketCalendarEvent? {
        var descriptor = FetchDescriptor<MarketCalendarEvent>(predicate: #Predicate { $0.docId == docId })
        descriptor.fetchLimit = 1
        return try? modelContext.fetch(descriptor).first
    }

    private func deleteModel<T: PersistentModel>(_ type: T.Type, docId: String, modelContext: ModelContext) {
        switch type {
        case is Trade.Type:
            if let m = fetchTrade(docId: docId, modelContext: modelContext) { modelContext.delete(m) }
        case is Dividend.Type:
            if let m = fetchDividend(docId: docId, modelContext: modelContext) { modelContext.delete(m) }
        case is MarketCalendarEvent.Type:
            if let m = fetchCalendarEvent(docId: docId, modelContext: modelContext) { modelContext.delete(m) }
        default:
            break
        }
    }
}
