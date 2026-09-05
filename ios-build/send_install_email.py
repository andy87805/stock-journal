"""
寄出「本週 StockJournal 安裝連結」的通知信。
沿用 stock-news-mailer 專案同一套 Gmail SMTP 寄信方式（App Password，非帳號密碼）。

環境變數（跟 stock-news-mailer 用同一組名稱，方便共用同一組 GitHub Secrets）：
  SENDER_EMAIL        寄件 Gmail 帳號
  GMAIL_APP_PASSWORD  該帳號的 App Password（不是登入密碼）
  RECIPIENT_EMAIL     收件人（通常是自己）
  PAGES_BASE_URL      GitHub Pages base URL，由 workflow 傳入
"""

import os
import smtplib
import ssl
from datetime import datetime
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

SMTP_HOST = "smtp.gmail.com"
SMTP_PORT = 465


def main():
    sender = os.environ["SENDER_EMAIL"]
    app_password = os.environ["GMAIL_APP_PASSWORD"]
    recipient = os.environ["RECIPIENT_EMAIL"]
    base_url = os.environ["PAGES_BASE_URL"].rstrip("/")

    manifest_url = f"{base_url}/manifest.plist"
    install_link = f"itms-services://?action=download-manifest&url={manifest_url}"
    page_url = f"{base_url}/index.html"
    today = datetime.now().strftime("%Y-%m-%d")

    html = f"""
    <div style="font-family:'Microsoft JhengHei',sans-serif;line-height:1.7;color:#222">
      <h2>StockJournal 本週建置完成 {today}</h2>
      <p>在手機上（Mail App 或 Safari 開啟本信）點以下連結直接安裝：</p>
      <p><a href="{install_link}" style="font-size:18px;font-weight:bold">安裝 StockJournal</a></p>
      <p style="color:#888;font-size:13px">
        如果上面連結沒反應，改用 Safari 開啟這頁再點安裝鈕：<br>
        <a href="{page_url}">{page_url}</a>
      </p>
      <p style="color:#888;font-size:13px">
        安裝後需到「設定 → 一般 → VPN 與裝置管理」信任開發者憑證才能開啟。
      </p>
    </div>
    """

    msg = MIMEMultipart("alternative")
    msg["Subject"] = f"StockJournal 安裝連結 {today}"
    msg["From"] = sender
    msg["To"] = recipient
    msg.attach(MIMEText(html, "html", "utf-8"))

    context = ssl.create_default_context()
    with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, context=context) as server:
        server.login(sender, app_password)
        server.sendmail(sender, recipient, msg.as_string())

    print("安裝連結已寄出")


if __name__ == "__main__":
    main()
