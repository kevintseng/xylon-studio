# XylonStudio

AI 驅動的晶片設計自動化平台。

🌐 **[xylonstud.io](https://xylonstud.io)** | 📖 **[English](README.md)** | **繁體中文**

---

## 展示

https://github.com/user-attachments/assets/b3598b06-df5a-4c50-8fd3-f27e0ca183e0

---

## 概述

XylonStudio 使用 AI 代理和開源 EDA 工具自動化晶片設計流程。

**核心功能：**
- 自然語言轉 RTL 生成
- 自動化測試台創建
- 時序優化
- 佈局驗證

---

## 架構

```
自然語言規格
    ↓
設計代理（RTL 生成）
    ↓
驗證代理（測試台 + 覆蓋率）
    ↓
優化代理（時序收斂）
    ↓
DRC 代理（佈局驗證）
    ↓
GDSII 輸出
```

---

## 技術堆疊

**後端：**
- Python 3.11+
- FastAPI
- vLLM（LLM 推理）
- PostgreSQL、Redis

**LLM：**
- DeepSeek Coder V2（236B）- 開源基礎模型
- 支援自架部署

**EDA 工具：**
- Yosys（合成）
- Verilator（模擬）
- OpenROAD（佈局與繞線）
- Magic（DRC/LVS）

**前端：**
- Next.js 16
- TypeScript
- Tailwind CSS

---

## 快速開始

### 前置需求
- Python 3.11+
- Node.js 20+
- Claude API key 或 OpenAI API key

### 安裝

```bash
# 複製專案
git clone https://github.com/kevintseng/xylon-studio.git
cd xylon-studio

# 後端設定
cd agent
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# 設置環境
cp ../.env.example ../.env
# 編輯 .env 填入您的 LLM API key

# 啟動 API server
python -m agent.main

# 前端設定（另開終端機）
cd ../web
npm install
npm run dev
```

### 使用範例

```bash
# 生成 RTL
curl -X POST http://localhost:5000/api/generate \
  -H "Content-Type: application/json" \
  -d '{
    "description": "16-bit barrel shifter with pipeline",
    "target_freq": "2 GHz"
  }'
```

---

## 專案結構

```
xylon/
├── agent/              # AI 代理服務（Python）
│   ├── dragons/        # 代理實作
│   ├── core/           # LLM gateway、orchestrator
│   ├── api/            # FastAPI routes
│   └── tests/          # 測試套件
├── web/                # Web UI（Next.js）
├── scripts/            # 部署腳本
├── docs/               # 文檔
└── examples/           # 範例設計
```

---

## 開發

### 後端

```bash
cd agent
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# 執行測試
pytest agent/tests/

# 啟動 API server
python -m agent.main
```

### 前端

```bash
cd web
npm install
npm run dev
```

---

## 文檔

- [API 文檔](docs/API.md) - API 參考
- [貢獻指南](CONTRIBUTING.md) - 貢獻流程
- [安全政策](SECURITY.md) - 安全回報

---

## 授權

XylonStudio 採用**雙授權模式**：

### 開源核心（MIT License）
核心平台（本儲存庫）採用 **MIT License** 授權：
- ✅ 可自由使用、修改和散布
- ✅ 允許商業用途
- ✅ 對企業或託管服務無限制
- ✅ 最低要求的開源授權

詳見 [LICENSE](LICENSE)。

### 專有企業功能
進階企業功能採用另外的商業授權：
- 進階優化演算法
- 企業級安全功能
- 多租戶架構
- 優先支援與 SLA

---

## 聯絡

**Email**: hello@xylonstud.io

---

## 貢獻

歡迎貢獻！請參閱 [CONTRIBUTING.md](CONTRIBUTING.md) 了解指南。

---

**使用技術**: OpenROAD、DeepSeek Coder、vLLM、Verilator
