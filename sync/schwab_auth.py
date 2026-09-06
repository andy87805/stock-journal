"""
一次性本機小工具：跑互動式 Schwab OAuth Authorization Code Flow，換取第一組 refresh_token。
不在 GitHub Actions 執行，只在本機手動跑一次。跑完把印出來的 refresh_token 貼到
GitHub Secrets 的 SCHWAB_REFRESH_TOKEN，之後 schwab_sync.py 就能用它換 access_token。

使用前提：
- 已在 Schwab Developer Portal 註冊好 App，Callback/Redirect URI 設定為 https://127.0.0.1:8182
  （Schwab 強制要求 https，這裡用自簽憑證 sync/.localcert/{cert,key}.pem 起本機 HTTPS server；
   瀏覽器會跳「不安全」警告，確認網址是 127.0.0.1:8182 後照樣繼續即可）
- 有該 App 的 Client ID / Client Secret
- sync/.localcert/cert.pem 與 key.pem 已存在（沒有的話跑一次：
  openssl req -x509 -newkey rsa:2048 -keyout sync/.localcert/key.pem -out sync/.localcert/cert.pem -days 3650 -nodes -subj "/CN=127.0.0.1"）

這是個人一次性使用的小工具，故意寫得很陽春（沒有做 state 驗證等強化），
不要把它當成正式的 OAuth server 使用。
"""
import argparse
import http.server
import os
import ssl
import urllib.parse
import webbrowser
from pathlib import Path

import requests

AUTHORIZE_URL = "https://api.schwabapi.com/v1/oauth/authorize"
TOKEN_URL = "https://api.schwabapi.com/v1/oauth/token"
REDIRECT_URI = "https://127.0.0.1:8182"
CERT_DIR = Path(__file__).parent / ".localcert"

auth_code_holder = {}


class CallbackHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)
        auth_code_holder["code"] = params.get("code", [None])[0]
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write("<html><body><h2>授權完成，可以關閉這個分頁了。</h2></body></html>".encode("utf-8"))

    def log_message(self, format, *args):
        pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--client-id", default=os.environ.get("SCHWAB_CLIENT_ID"))
    parser.add_argument("--client-secret", default=os.environ.get("SCHWAB_CLIENT_SECRET"))
    args = parser.parse_args()

    if not args.client_id or not args.client_secret:
        raise SystemExit("需要 SCHWAB_CLIENT_ID / SCHWAB_CLIENT_SECRET（環境變數或 --client-id / --client-secret 帶入）")

    auth_url = f"{AUTHORIZE_URL}?" + urllib.parse.urlencode(
        {
            "response_type": "code",
            "client_id": args.client_id,
            "redirect_uri": REDIRECT_URI,
        }
    )
    print(f"開啟瀏覽器進行授權：{auth_url}")
    webbrowser.open(auth_url)

    cert_path = CERT_DIR / "cert.pem"
    key_path = CERT_DIR / "key.pem"
    if not cert_path.exists() or not key_path.exists():
        raise SystemExit(
            f"找不到自簽憑證，先跑：\nopenssl req -x509 -newkey rsa:2048 "
            f"-keyout {key_path} -out {cert_path} -days 3650 -nodes -subj \"/CN=127.0.0.1\""
        )

    server = http.server.HTTPServer(("127.0.0.1", 8182), CallbackHandler)
    ssl_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ssl_context.load_cert_chain(certfile=str(cert_path), keyfile=str(key_path))
    server.socket = ssl_context.wrap_socket(server.socket, server_side=True)
    print("等待瀏覽器授權導回 https://127.0.0.1:8182 ...")
    while "code" not in auth_code_holder:
        server.handle_request()

    code = auth_code_holder["code"]
    if not code:
        raise SystemExit("沒有從 callback 拿到 code，授權失敗")

    resp = requests.post(
        TOKEN_URL,
        data={
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": REDIRECT_URI,
        },
        auth=(args.client_id, args.client_secret),
        timeout=30,
    )
    resp.raise_for_status()
    tokens = resp.json()

    print("\n=== 授權成功 ===")
    print(f"refresh_token: {tokens.get('refresh_token')}")
    print("\n把上面這串 refresh_token 貼到 GitHub Secrets 的 SCHWAB_REFRESH_TOKEN。")
    print("注意：Schwab refresh_token 效期只有 7 天，之後需要重新跑一次這支腳本取得新的。")


if __name__ == "__main__":
    main()
