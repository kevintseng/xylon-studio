# XylonStudio

以 Verilator 與 Yosys 執行真實、可重現的本機 RTL 驗證。

📖 **[English](README.md)**

## 現在真正能做什麼

XylonStudio 目前只提供一條有工具證據的驗證流程：

```text
使用者意圖
  -> 固定版本 runtime preflight
  -> Verilator lint
  -> 選填的獨立 C++ 自我檢查模擬
  -> coverage 證據
  -> 選填的 Yosys 合成報告
  -> 含 checksum 的 artifacts 與精確重跑
```

CLI、REST API、WebSocket 與 Web UI 共用相同 run contract。UI 提供可互動的 gate flow、責任邊界、工具證據、確定性結果與下一個復原動作。

真實性規則：

- 只有 lint 的執行結果是 `lint_only`，絕不是功能驗證。
- `verified` 必須有獨立自我檢查 C++ testbench、明確 `PASS`、所有必要 gate 通過，且 coverage 達到使用者目標。
- 缺少的 coverage 會保持 unavailable，不會顯示為 `0%`，也不會用另一個指標填補。
- 設定錯誤、環境錯誤、取消、不支援輸入、驗證失敗、未達目標與證據不足都是不同結果。
- 每次 terminal run 預設在 `.xylon/runs/` 保存輸入、證據、checksum 與 rerun manifest。

## 尚未實作

XylonStudio 目前不會用 AI 生成 RTL 或 testbench、不會執行 OpenROAD 實體設計、不會進行 DRC/LVS sign-off，也不能判定投片就緒。Agentic OpenROAD 是已研究的 roadmap，不是現行能力。

## 快速開始

### 前置需求

- Python 3.11+
- Node.js 20.9+（建議使用仍在支援期的 Node.js LTS）
- Docker Desktop 或 Docker Engine
- 最低 8 GB RAM；本機流程建議 16 GB

### 一次性安裝

從 repository root 執行：

```bash
python3 -m venv agent/venv
agent/venv/bin/pip install -r requirements.txt

cd web
npm ci
npm run build
cd ..
```

鎖定的 Web stack 使用 Next.js 16 與 React 19。Production build 採用
Next.js 正式支援的 Webpack 路徑與本機系統字型，因此乾淨建置不依賴
Google Fonts 或 Turbopack 的內部本機 socket。`doctor` 會在啟動服務前
檢查實際安裝的 Python 與 Node.js 版本。

### 啟動完整本機產品

單一指令會管理固定版本 EDA runtime、一個 API worker 與 production web server：

```bash
scripts/xylon doctor
scripts/xylon start
```

開啟 [http://127.0.0.1:3000/pipeline](http://127.0.0.1:3000/pipeline)。狀態、log 與安全停止都使用相同入口，而且只操作它自己啟動的程序：

```bash
scripts/xylon status
scripts/xylon logs --tail 100
scripts/xylon stop
```

如果 3000 已被另一個本機專案使用，不需要停止它；可改用
`scripts/xylon start --web-port 3100`。選定的 port 會寫入 launcher state，
後續仍可直接使用一般的 `status` 與 `stop`。

如果一分鐘 CPU load 已達 logical CPU 數、可用記憶體低於 20%、workspace 磁碟低於 10 GiB，或選定的 port 已被占用，`start` 會拒絕增加負載。部分啟動失敗會自動 rollback；port 與程序身分記錄在 `.xylon/local/state.json`，避免 `stop` 誤殺被重用的 PID。本次 session log 位於 `.xylon/local/logs/`。

第一次啟動會建立含固定 commit Verilator 5.050 與 Yosys 0.65 的 image，可能需要數分鐘；之後直接重用。Xylon 會限制兩個 EDA container、只啟動一個 API worker，並依序執行高負載 gate。

### 使用 CLI

```bash
# 只產生語法與 lint 證據，結果是 lint_only。
agent/venv/bin/python -m agent.cli run examples/adder/adder_8bit.v

# 使用獨立 C++ 自我檢查做功能驗證。
agent/venv/bin/python -m agent.cli run \
  examples/adder/adder_8bit.v \
  --testbench examples/adder/tb_adder_8bit.cpp \
  --coverage-target 0.80 \
  --synthesis
```

終端機會顯示 canonical outcome、gate 證據、coverage 可用性、artifact manifest 與精確重跑指令。

```bash
agent/venv/bin/python -m agent.cli rerun \
  .xylon/runs/<pipeline-id>/manifest.json
```

### 引導式 Web 工作流程

產品刻意只保留 `/` 與 `/pipeline` 兩條 route。某些 macOS Control Center 會使用 port 5000，所以本機 API 固定使用 5001。

Pipeline 預設載入完整的 adder 驗證任務與獨立 testbench，因此第一次執行會做真實功能檢查，而不只是 lint。介面提供四個引導式任務：

- 預期通過的 adder、counter 與交通號誌 FSM，分別涵蓋組合、循序與狀態機行為。
- 一個診斷任務：RTL 刻意把 carry-in 計算兩次，但沿用正確、獨立的 adder checks。預期結果為 `verification_failed`；結果卡會直接顯示第一個失敗的自我檢查，完整 simulator 輸出仍可在 Simulation gate 展開。

只要編輯任一輸入，情境就會切換為自訂任務；此時預期結果會標示 unavailable，因為 Xylon 不會在工具執行前猜測結果。

使用完成後停止整個自有 stack：

```bash
scripts/xylon stop
```

## API

只有 canonical pipeline 是公開 API：

| 方法 | 路徑 | 用途 |
| --- | --- | --- |
| `POST` | `/api/pipeline/run` | 執行完整 REST run |
| `WS` | `/api/pipeline/ws` | 串流 gate 進度與相同 terminal result |
| `GET` | `/health` | API process health |

請見 [docs/API.md](docs/API.md)。已移除的 Design／Verification Dragon 與 LLM generation 欄位會被拒絕，沒有 compatibility shim。

## 支援輸入與證據

- RTL：Verilog 與固定版本 Verilator／Yosys 可接受的子集。
- 功能測試：由 Verilator 編譯的 C++ testbench。它必須自行檢查，並只在所有檢查通過後輸出 `PASS`；任何 `FAIL` marker 都優先判定失敗。
- Coverage：只填入固定 Verilator report 中實際解析到的指標。目前範例可取得 toggle coverage；line／branch 可能 unavailable。
- Synthesis：選填的 Yosys 結構統計。它不證明面積、功耗、timing closure 或實體可行性。

可用 RTL/testbench 組合位於 `examples/adder`、`examples/counter`、`examples/fsm`、`examples/barrel_shifter` 與 `examples/risc-v-alu`。

## 開發驗證

在資源有限的本機依序執行：

```bash
agent/venv/bin/pip install -r requirements-dev.txt
agent/venv/bin/python -m pytest -q agent
agent/venv/bin/python -m ruff check agent setup.py

cd web
node --experimental-strip-types --test lib/*.test.ts
npm run type-check
npm run build
```

Compose 會把每個 EDA 容器限制為 2 CPU、4 GB，而且不自動重啟。Launcher
只啟動一個 API worker；REST 與 WebSocket pipeline 會被序列化，確保同一時間
只有一個重型 EDA 工作。開發者仍可用 `scripts/eda-runtime` 手動管理 runtime，
但那不是一般產品入口。

標記為 Docker integration 的測試應在固定 runtime healthy 後另外執行。Offline test 不等於真實 EDA runtime 證據。

## 專案結構

```text
xylon/
├── agent/
│   ├── pipeline/          # Canonical model、runner、gate 與 artifacts
│   ├── api/               # Pipeline REST 與 WebSocket adapters
│   ├── sandbox/           # 固定 runtime 檢查與 container execution
│   └── cli.py             # Run 與精確 rerun 指令
├── runtime/               # 固定 Verilator/Yosys image 定義
├── scripts/eda-runtime    # Runtime lifecycle 與驗證
├── web/
│   ├── app/               # 真實首頁與 pipeline routes
│   └── lib/               # 共用 UI contract 與雙語文案
├── examples/              # RTL 與獨立 C++ 自我檢查
└── docs/API.md            # 公開 API contract
```

## 授權與貢獻

本 repository 採用 [MIT License](LICENSE)。貢獻必須維持 evidence boundary：沒有真實 runtime 證據前，不得在文件或 UI 宣稱能力。請見 [CONTRIBUTING.md](CONTRIBUTING.md)。
