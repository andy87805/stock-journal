"""
把 Firestore `calendarEvents` 裡近期的除權息日／財報日，彙整成一封提醒信寄出。
PWA 內也看得到這些日期，但那要自己想到去開 App；這支腳本負責主動推到信箱。

環境變數：SENDER_EMAIL、GMAIL_APP_PASSWORD、RECIPIENT_EMAIL
（選填 SMTP_HOST / SMTP_PORT，預設 smtp.gmail.com:465）
"""
import argparse
import os
import smtplib
import ssl
import sys
from datetime import date, datetime, timedelta
from email.mime.text import MIMEText

DEFAULT_DAYS = 7
TYPE_LABELS = {"exDividend": "除權息", "earnings": "財報"}
MARKET_LABELS = {"TW": "台股", "US": "美股"}


def generate_dry_run_events():
    today = date.today()
    return [
        {"symbol": "2330", "market": "TW", "type": "exDividend",
         "eventDate": (today + timedelta(days=2)).isoformat()},
        {"symbol": "0050", "market": "TW", "type": "exDividend",
         "eventDate": (today + timedelta(days=5)).isoformat()},
        {"symbol": "AAPL", "market": "US", "type": "earnings",
         "eventDate": (today + timedelta(days=3)).isoformat()},
    ]


def fetch_upcoming_events(db, days):
    today = date.today()
    start = today.isoformat()
    # eventDate 是 ISO8601 字串，字典序等於時間序，所以直接用字串範圍查詢。
    # 上界取「最後一天的隔天 00:00」當開區間，才不會漏掉帶時間部分的值。
    end_exclusive = (today + timedelta(days=days + 1)).isoformat()

    events = []
    query = (
        db.collection("calendarEvents")
        .where("eventDate", ">=", start)
        .where("eventDate", "<", end_exclusive)
    )
    for doc in query.stream():
        data = doc.to_dict()
        if data.get("eventDate") and data.get("symbol"):
            events.append(data)
    return events


def event_sort_key(event):
    return (event["eventDate"][:10], event.get("symbol", ""))


def format_event_date(raw):
    try:
        return datetime.fromisoformat(raw[:10]).strftime("%m/%d")
    except ValueError:
        return raw[:10]


def build_email(events, days):
    today = date.today()
    subject = f"近 {days} 天除權息／財報提醒（{today:%Y-%m-%d}）"

    lines = [f"以下是 {today:%Y-%m-%d} 起 {days} 天內的行事曆事件：", ""]
    for event_type, label in TYPE_LABELS.items():
        group = sorted(
            (e for e in events if e.get("type") == event_type), key=event_sort_key
        )
        if not group:
            continue
        lines.append(f"【{label}】")
        for event in group:
            market = MARKET_LABELS.get(event.get("market"), event.get("market", ""))
            lines.append(
                f"  {format_event_date(event['eventDate'])}  {event['symbol']}  {market}"
            )
        lines.append("")

    other = sorted(
        (e for e in events if e.get("type") not in TYPE_LABELS), key=event_sort_key
    )
    if other:
        lines.append("【其他】")
        for event in other:
            market = MARKET_LABELS.get(event.get("market"), event.get("market", ""))
            lines.append(
                f"  {format_event_date(event['eventDate'])}  {event['symbol']}  {market}  {event.get('type', '')}"
            )
        lines.append("")

    lines.append("本信由 stock-journal 自動寄出，資料來源為公開行事曆，可能有誤或遺漏。")
    return subject, "\n".join(lines)


def send_email(subject, body):
    sender = os.environ["SENDER_EMAIL"]
    password = os.environ["GMAIL_APP_PASSWORD"]
    recipient = os.environ["RECIPIENT_EMAIL"]
    smtp_host = os.environ.get("SMTP_HOST", "smtp.gmail.com")
    smtp_port = int(os.environ.get("SMTP_PORT", 465))

    msg = MIMEText(body, "plain", "utf-8")
    msg["Subject"] = subject
    msg["From"] = sender
    msg["To"] = recipient

    context = ssl.create_default_context()
    with smtplib.SMTP_SSL(smtp_host, smtp_port, context=context) as server:
        server.login(sender, password)
        server.sendmail(sender, recipient, msg.as_string())


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser()
    parser.add_argument("--days", type=int, default=DEFAULT_DAYS, help="往後看幾天，預設 7")
    parser.add_argument("--dry-run", action="store_true", help="不連線 Firestore/SMTP，用範例資料印出信件內容")
    args = parser.parse_args()

    if args.dry_run:
        cutoff = (date.today() + timedelta(days=args.days)).isoformat()
        sample = [e for e in generate_dry_run_events() if e["eventDate"][:10] <= cutoff]
        subject, body = build_email(sample, args.days)
        print(f"Subject: {subject}\n")
        print(body)
        return

    from firestore_client import init_firestore

    db = init_firestore()
    events = fetch_upcoming_events(db, args.days)
    if not events:
        print(f"[send_reminders] 近 {args.days} 天沒有行事曆事件，不寄信")
        return

    subject, body = build_email(events, args.days)
    send_email(subject, body)
    print(f"[send_reminders] 已寄出提醒信，共 {len(events)} 筆事件")


if __name__ == "__main__":
    main()
