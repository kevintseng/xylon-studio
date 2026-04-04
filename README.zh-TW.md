# XylonStudio

開源晶片驗證流水線。學習。驗證。投片。

🌐 **[xylonstud.io](https://xylonstud.io)** | 📖 **[English](README.md)** | **繁體中文**

---

## 展示

https://github.com/user-attachments/assets/b3598b06-df5a-4c50-8fd3-f27e0ca183e0

---

## 概述

XylonStudio 是一個 AI 輔助的晶片驗證平台。從 RTL 自動生成測試計畫、測試平台與覆蓋率報告。開源、可插拔 LLM、教育優先。

**核心功能：**
- 從 RTL 分析自動生成驗證測試計畫
- C++ Verilator 測試平台生成（含覆蓋率支援）
- 覆蓋率驅動迭代迴圈（自動改善直到達標）
- Docker 容器中的真實 Verilator 模擬
- 可插拔 LLM（Ollama、vLLM — 自帶模型）
- 教學模式，逐步解說每個驗證步驟
- 即時 WebSocket 串流的流水線視覺化

---

## 架構

```
RTL 程式碼
    ↓
Lint 檢查 (Verilator)
    ↓
測試計畫生成 (LLM)
    ↓
測試平台生成 (LLM)
    ↓
┌─── 模擬 (Verilator) ◄──────┐
│        ↓                     │
│   覆蓋率分析                  │
│        ↓                     │
│   達標？── 否 ── 改善測試平台 (LLM)
│        │
│       是
│        ↓
└── 覆蓋率報告
```

---

## 技術堆疊

**後端：**
- Python 3.11+
- FastAPI
- 非同步流水線執行器（含步驟回呼）

**LLM（自帶模型）：**
- Ollama（qwen2.5-coder、deepseek-coder 等）
- vLLM（自架部署）
- 任何 OpenAI 相容 API

**EDA 工具（Docker）：**
- Verilator（lint、模擬、覆蓋率）
- Yosys（合成）

**前端：**
- Next.js 14
- TypeScript
- Tailwind CSS
- WebSocket 即時流水線更新

---

## 快速開始

### 前置需求
- Python 3.11+
- Node.js 20+
- Docker（Verilator/Yosys 容器）
- Ollama 或 vLLM endpoint（LLM 功能用）

### 安裝

```bash
# 複製儲存庫
git clone https://github.com/kevintseng/xylon-studio.git
cd xylon-studio

# 後端設定
cd agent
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# 啟動 API 伺服器
uvicorn agent.api.main:app --host 0.0.0.0 --port 5000

# 前端設定（另開終端機）
cd ../web
npm install
npm run dev
```

### 範例：執行流水線

```bash
# Phase A：用自己的測試平台做 lint + 模擬
curl -X POST http://localhost:5000/api/pipeline/run \
  -H "Content-Type: application/json" \
  -d '{
    "rtl_code": "module adder(input [7:0] a, b, output [8:0] sum); assign sum = a + b; endmodule",
    "testbench_code": "...",
    "coverage_target": 0.80
  }'

# Phase B：LLM 自動生成測試計畫 + 測試平台
curl -X POST http://localhost:5000/api/pipeline/run \
  -H "Content-Type: application/json" \
  -d '{
    "rtl_code": "module adder(input [7:0] a, b, output [8:0] sum); assign sum = a + b; endmodule",
    "coverage_target": 0.80,
    "llm_config": {
      "type": "ollama",
      "endpoint": "http://localhost:11434",
      "model": "qwen2.5-coder:32b"
    }
  }'
```

---

## 範例設計

| 設計 | 類型 | 測試數 | 行覆蓋率 |
|------|------|--------|----------|
| [8 位元加法器](examples/adder/) | 組合邏輯 | 25 | 100% |
| [8 位元計數器](examples/counter/) | 序列邏輯 | 10 | 100% |
| [交通號誌 FSM](examples/fsm/) | 狀態機 | 9 | 79% |

每個範例都包含 RTL 原始碼和已驗證的 C++ Verilator 測試平台。

---

## 專案結構

```
xylon/
├── agent/                  # 後端 (Python/FastAPI)
│   ├── core/               # LLM 提供者抽象層
│   ├── pipeline/           # 流水線執行器 + 步驟函式
│   │   ├── steps/          # lint, test_plan, testbench_gen, simulate, coverage, improve
│   │   └── tests/          # 12 個單元/整合測試
│   ├── api/                # REST + WebSocket 端點
│   └── sandbox/            # Docker EDA 容器管理
├── web/                    # 前端 (Next.js)
│   ├── app/                # 頁面：首頁、設計、驗證、流水線、歷史
│   ├── components/         # UI 元件
│   └── lib/                # i18n（EN + zh-TW）
├── examples/               # 範例 RTL 設計（含測試平台）
└── docs/                   # 設計文件
```

---

## 開發

### 後端

```bash
cd agent
source venv/bin/activate

# 執行測試
pytest agent/pipeline/tests/ -v

# 啟動 API 伺服器
uvicorn agent.api.main:app --reload --port 5000
```

### 前端

```bash
cd web
npm install
npm run dev
```

---

## API 端點

| 方法 | 路徑 | 說明 |
|------|------|------|
| POST | `/api/pipeline/run` | 執行驗證流水線（REST） |
| WS | `/api/pipeline/ws` | 即時串流執行流水線 |
| POST | `/api/design/generate` | 從描述生成 RTL |
| POST | `/api/verification/verify` | 用測試平台驗證 RTL |

---

## 授權

XylonStudio 採用**雙授權模式**：

### 開源核心（MIT License）
核心平台（本儲存庫）採用 **MIT License** 授權：
- ✅ 可自由使用、修改與散佈
- ✅ 允許商業使用
- ✅ 開源，最少限制

完整條款請見 [LICENSE](LICENSE)。

### 專有企業功能
進階企業功能以獨立商業授權提供。

---

## 聯絡

**Email**：hello@xylonstud.io

---

## 貢獻

歡迎貢獻！請參閱 [CONTRIBUTING.md](CONTRIBUTING.md) 了解指引。

---

**使用技術**：Verilator、Yosys、Ollama、FastAPI、Next.js
