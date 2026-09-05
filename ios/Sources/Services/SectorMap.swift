import Foundation

// TODO: This is a small illustrative sample, not a real sector database.
// Extend this dictionary (or replace with a bundled JSON / remote lookup) as needed.
enum SectorMap {
    static let uncategorized = "未分類"

    private static let bySymbol: [String: String] = [
        "2330": "半導體",
        "2317": "電子代工",
        "2454": "半導體",
        "2881": "金融",
        "2882": "金融",
        "0050": "ETF",
        "0056": "ETF",
        "AAPL": "Technology",
        "MSFT": "Technology",
        "GOOGL": "Technology",
        "AMZN": "Consumer Discretionary",
        "NVDA": "Technology",
        "TSLA": "Consumer Discretionary",
        "VOO": "ETF",
        "SPY": "ETF",
    ]

    static func sector(for symbol: String) -> String {
        bySymbol[symbol] ?? uncategorized
    }
}
