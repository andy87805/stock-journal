"""
產生 iOS OTA (over-the-air) 安裝用的 manifest.plist + index.html。

輸入：
  ios-build/output/StockJournal.ipa   （由 Fastfile 的 build_and_publish lane 產生）

輸出（放進 ios-build/publish/，之後由 workflow 整包 push 到 gh-pages）：
  ios-build/publish/StockJournal.ipa
  ios-build/publish/manifest.plist
  ios-build/publish/index.html

環境變數：
  PAGES_BASE_URL   GitHub Pages 的 base URL，例如
                    https://<github-username>.github.io/stock-journal
                    由 workflow 用 github.repository_owner 組出來，避免這裡猜測/寫死使用者名稱。

bundle id 必須跟 ios/project.yml 裡的 PRODUCT_BUNDLE_IDENTIFIER 保持一致，
目前兩邊都是 com.andy878005.stockjournal —— 改一邊記得同步改另一邊。
"""

import os
import plistlib
import shutil
from datetime import datetime
from pathlib import Path

BASE_DIR = Path(__file__).parent
IPA_SRC = BASE_DIR / "output" / "StockJournal.ipa"
PUBLISH_DIR = BASE_DIR / "publish"

BUNDLE_ID = "com.andy878005.stockjournal"
TITLE = "StockJournal"
IPA_FILENAME = "StockJournal.ipa"


def build_manifest(base_url: str, version: str) -> bytes:
    ipa_url = f"{base_url}/{IPA_FILENAME}"
    manifest = {
        "items": [
            {
                "assets": [
                    {
                        "kind": "software-package",
                        "url": ipa_url,
                    }
                ],
                "metadata": {
                    "kind": "software",
                    "bundle-identifier": BUNDLE_ID,
                    "bundle-version": version,
                    "title": TITLE,
                },
            }
        ]
    }
    return plistlib.dumps(manifest)


def build_index_html(base_url: str) -> str:
    manifest_url = f"{base_url}/manifest.plist"
    install_link = f"itms-services://?action=download-manifest&url={manifest_url}"
    today = datetime.now().strftime("%Y-%m-%d")
    return f"""<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>安裝 StockJournal</title>
<style>
  body {{ font-family: -apple-system, sans-serif; text-align: center; padding: 60px 20px; background: #f5f5f7; }}
  a.install {{
    display: inline-block; padding: 18px 40px; font-size: 20px; font-weight: 600;
    color: #fff; background: #007aff; border-radius: 12px; text-decoration: none;
  }}
  p {{ color: #666; margin-top: 24px; font-size: 14px; }}
</style>
</head>
<body>
<h1>StockJournal</h1>
<p>建置日期：{today}</p>
<a class="install" href="{install_link}">安裝 StockJournal</a>
<p>請用 iPhone 的 Safari 開啟本頁並點擊上方連結安裝。<br>
需先在「設定 → 一般 → VPN 與裝置管理」信任此開發者憑證，才能開啟 App。</p>
</body>
</html>
"""


def main():
    base_url = os.environ.get("PAGES_BASE_URL", "").rstrip("/")
    if not base_url:
        raise SystemExit("PAGES_BASE_URL 環境變數未設定")

    if not IPA_SRC.exists():
        raise SystemExit(f"找不到 {IPA_SRC}，請確認 fastlane build 步驟有成功產生 .ipa")

    PUBLISH_DIR.mkdir(parents=True, exist_ok=True)
    shutil.copy2(IPA_SRC, PUBLISH_DIR / IPA_FILENAME)

    version = datetime.now().strftime("%Y%m%d")  # 簡單遞增版本號，每週 rebuild 一次剛好夠用

    (PUBLISH_DIR / "manifest.plist").write_bytes(build_manifest(base_url, version))
    (PUBLISH_DIR / "index.html").write_text(build_index_html(base_url), encoding="utf-8")

    print(f"已產生 manifest.plist / index.html，version={version}，base_url={base_url}")


if __name__ == "__main__":
    main()
