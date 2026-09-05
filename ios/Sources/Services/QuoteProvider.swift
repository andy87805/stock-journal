import Foundation

protocol QuoteProvider {
    func currentPrice(symbol: String, market: String) async -> Double?
}

// TODO: Wire this up to a real quote source later, e.g. Yahoo Finance's unofficial
// chart endpoint, or whichever broker API (Sinopac/Schwab) exposes live quotes.
// Kept as a no-op seam for now so PositionsView can show "-" for unrealized P&L
// instead of crashing/faking a network call that doesn't exist yet.
struct NoopQuoteProvider: QuoteProvider {
    func currentPrice(symbol: String, market: String) async -> Double? {
        nil
    }
}
