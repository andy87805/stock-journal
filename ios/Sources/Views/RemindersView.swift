import SwiftUI
import SwiftData

struct RemindersView: View {
    @Query(sort: \MarketCalendarEvent.eventDate) private var events: [MarketCalendarEvent]

    private var upcoming: [MarketCalendarEvent] {
        let now = Date()
        return events.filter { $0.eventDate >= Calendar.current.startOfDay(for: now) }
    }

    private var thisWeek: [MarketCalendarEvent] {
        guard let weekEnd = Calendar.current.dateInterval(of: .weekOfYear, for: Date())?.end else { return [] }
        return upcoming.filter { $0.eventDate < weekEnd }
    }

    private var thisMonth: [MarketCalendarEvent] {
        guard let weekEnd = Calendar.current.dateInterval(of: .weekOfYear, for: Date())?.end,
              let monthEnd = Calendar.current.dateInterval(of: .month, for: Date())?.end else { return [] }
        return upcoming.filter { $0.eventDate >= weekEnd && $0.eventDate < monthEnd }
    }

    private var later: [MarketCalendarEvent] {
        guard let monthEnd = Calendar.current.dateInterval(of: .month, for: Date())?.end else { return [] }
        return upcoming.filter { $0.eventDate >= monthEnd }
    }

    var body: some View {
        Group {
            if upcoming.isEmpty {
                ContentUnavailableView("尚無提醒", systemImage: "bell", description: Text("目前沒有即將到來的除權息日或財報日"))
            } else {
                List {
                    if !thisWeek.isEmpty {
                        Section("本週") { ForEach(thisWeek) { EventRow(event: $0) } }
                    }
                    if !thisMonth.isEmpty {
                        Section("本月") { ForEach(thisMonth) { EventRow(event: $0) } }
                    }
                    if !later.isEmpty {
                        Section("更晚") { ForEach(later) { EventRow(event: $0) } }
                    }
                }
            }
        }
        .navigationTitle("提醒")
    }
}

private struct EventRow: View {
    let event: MarketCalendarEvent

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(event.symbol)
                        .font(.headline)
                    Text(event.typeEnum?.displayName ?? event.type)
                        .font(.caption)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color.accentColor.opacity(0.15))
                        .foregroundStyle(Color.accentColor)
                        .clipShape(Capsule())
                }
                if let note = event.note, !note.isEmpty {
                    Text(note)
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
            }
            Spacer()
            Text(event.eventDate, format: .dateTime.month().day())
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
    }
}

#Preview {
    NavigationStack { RemindersView() }
}
