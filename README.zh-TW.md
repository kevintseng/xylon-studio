# XylonStudio

以真實工具與可查驗的執行證據進行本機 RTL 驗證，並透過受限介面操作真實
OpenROAD。

[English](README.md)

## 現在可用

Xylon 目前提供兩項真實且彼此獨立的功能：

1. **RTL 驗證**：執行固定版本的 Verilator lint、選用的獨立 C++ 自我檢查、
   覆蓋率收集、選用的 Yosys 結構統計，以及可精確重跑且經 SHA-256 完整性檢查的證據包。
2. **OpenROAD MCP 控制介面**：讓支援 MCP 的 AI 助理建立一個資源受限的真實
   OpenROAD 工作階段、執行受限指令，並在網頁顯示最新執行紀錄。

OpenROAD 介面目前只是安全操作工具的基礎，還不是完整的 RTL→GDS 產品流程。
Xylon 目前還不能匯入完整的 RTL／SDC／PDK 設計、找出最差時序路徑，或執行
並比較時序改善結果。

## 接下來完成什麼

下一個產品切片是完整的時序分析與改善流程：

```text
真實 RTL + SDC + PDK 版本資訊
  -> 在 OpenROAD 載入設計
  -> 產生報告並解釋最差時序路徑
  -> 提出一項範圍受限的修改
  -> 使用者在外部 MCP 用戶端確認執行
  -> 重新產生相同指標的報告
  -> 比較前後結果
  -> 失敗時提供下一個可執行動作
```

在整條路徑以結果讀回證據跑通前，介面會標示尚未可用。只有工具連線、
流程圖、模擬資料或 AI 助理回答都不算完成。

## 執行 RTL 驗證

需求：Python 3.11+、Node.js 22+、Docker、至少 8 GB RAM（建議 16 GB）。

```bash
python3 -m venv agent/venv
agent/venv/bin/python -m pip install --require-hashes -r requirements.lock

cd web
npm ci
npm run build
cd ..

scripts/xylon doctor
scripts/xylon start
```

開啟 [http://127.0.0.1:3000/pipeline](http://127.0.0.1:3000/pipeline)。頁面會先
載入真實範例 RTL 與獨立測試程式。下列指令只會查看或停止此工作目錄自行管理的服務：

```bash
scripts/xylon status
scripts/xylon logs --tail 100
scripts/xylon stop
```

只有 lint 的結果不會被稱為功能驗證。內部狀態 `verified` 只表示您提供的
自我檢查、必要關卡、指定的實測覆蓋率與最終證據檔案讀回均已通過。介面會顯示
「所提供的檢查已通過」，因為 Xylon 尚不能證明使用者提供的測試程式已完整涵蓋
設計規格。

## 連接 OpenROAD

OpenROAD 是獨立、按需啟動的 MCP 執行環境；`scripts/xylon` 不管理它。

```bash
scripts/xylon-openroad install
scripts/xylon-openroad doctor
scripts/xylon-openroad config
```

把輸出的設定加入支援 MCP 的 AI 助理，再開啟
[http://127.0.0.1:3000/openroad](http://127.0.0.1:3000/openroad) 查看最新工作階段
與指令證據。

唯讀指令可直接執行。會改變狀態的指令必須先準備，並綁定精確的工作階段與
指令內容後才能執行。外部 MCP 用戶端負責取得操作人員確認；Xylon 不驗證或
記錄確認者身分。

`scripts/xylon-openroad install` 會下載大型、固定版本的 `linux/amd64` OpenROAD
映像檔。在 Apple Silicon 上會透過相容層執行；如果本機 CPU、記憶體或磁碟空間
不足，啟動前的資源檢查會拒絕執行。每次開始 RTL 驗證流程或建立 OpenROAD
工作階段之前，Xylon 都會重新檢查；若資源不足，不會啟動 EDA 工具，畫面會說明
需要釋出哪一項資源，待本機負載降低後即可重試。

## 目前邊界

| 現在可用 | 尚未可用 |
| --- | --- |
| Verilator／Yosys RTL 驗證 | AI 產生 RTL 或測試程式 |
| 經 SHA-256 完整性檢查的結果檔案與精確重跑 | 匯入完整 RTL／SDC／PDK 設計 |
| 受限的真實 OpenROAD MCP 工作階段 | 自動改善最差時序路徑 |
| 最新 OpenROAD 執行紀錄讀回 | DRC／LVS 通過判定或投片就緒判定 |

缺少、過期、失敗、中斷或無法判定的證據都不會變成完成狀態。

## 使用入口

- `/pipeline`：執行目前的 RTL 驗證流程。
- `/openroad`：查看獨立的 OpenROAD MCP 執行紀錄。
- `POST /api/pipeline/run` 與 `WS /api/pipeline/ws`：標準驗證流程。
- `GET /api/openroad/snapshot`：讀取範圍受限的 OpenROAD 執行紀錄。
- `agent/venv/bin/python -m agent.cli run ...` 與 `agent/venv/bin/python -m agent.cli rerun ...`：CLI 與精確重跑。

詳細規格請見 [API 說明](docs/API.md)、[安全邊界](SECURITY.md) 與
[貢獻規範](CONTRIBUTING.md)。

## 驗證變更

資源有限的本機應依序執行高負載檢查：

```bash
agent/venv/bin/python -m pytest -q agent
agent/venv/bin/python -m ruff check agent

cd web
npm run test:contracts
npm run lint
npm run type-check
npm run build
```

離線測試只證明程式介面。任何真實 EDA 或使用者流程宣稱，都必須在同一版本上
取得固定執行環境、結果讀回、失敗路徑、清理、獨立審查與受保護 CI 的證據。

## 授權

[MIT](LICENSE)
