import SwiftUI
import SwiftData
import FirebaseCore
import FirebaseAuth

@main
struct StockJournalApp: App {
    let modelContainer: ModelContainer
    @State private var sync = FirestoreSync()

    init() {
        FirebaseApp.configure()

        do {
            modelContainer = try ModelContainer(for: Trade.self, Dividend.self, MarketCalendarEvent.self)
        } catch {
            fatalError("Failed to create ModelContainer: \(error)")
        }

        signInAnonymouslyIfNeeded()
    }

    var body: some Scene {
        WindowGroup {
            RootTabView()
                .task {
                    sync.startListening(modelContext: modelContainer.mainContext)
                }
        }
        .modelContainer(modelContainer)
    }

    private func signInAnonymouslyIfNeeded() {
        guard Auth.auth().currentUser == nil else { return }
        Auth.auth().signInAnonymously { _, error in
            if let error {
                print("Anonymous sign-in failed: \(error.localizedDescription)")
            }
        }
    }
}

struct RootTabView: View {
    var body: some View {
        TabView {
            NavigationStack {
                DashboardView()
            }
            .tabItem { Label("總覽", systemImage: "chart.line.uptrend.xyaxis") }

            NavigationStack {
                TradesListView()
            }
            .tabItem { Label("交易紀錄", systemImage: "list.bullet.rectangle") }

            NavigationStack {
                PositionsView()
            }
            .tabItem { Label("持股庫存", systemImage: "briefcase") }

            NavigationStack {
                AnalysisHubView()
            }
            .tabItem { Label("分析", systemImage: "chart.pie") }

            NavigationStack {
                MoreHubView()
            }
            .tabItem { Label("更多", systemImage: "ellipsis.circle") }
        }
    }
}

/// Groups the analysis-flavored screens under one tab so the tab bar stays readable.
struct AnalysisHubView: View {
    var body: some View {
        List {
            NavigationLink("已實現損益") { RealizedPnLView() }
            NavigationLink("損益走勢圖") { PnLChartView() }
            NavigationLink("曝險比例") { ExposureChartView() }
            NavigationLink("交易統計") { TradeStatsView() }
        }
        .navigationTitle("分析")
    }
}

/// Groups the lower-frequency screens under one tab so the tab bar stays readable.
struct MoreHubView: View {
    var body: some View {
        List {
            NavigationLink("股利紀錄") { DividendsView() }
            NavigationLink("提醒") { RemindersView() }
            NavigationLink("報表匯出") { ReportExportView() }
        }
        .navigationTitle("更多")
    }
}
