# ⚔ 泰瑞 AI 軍團 指揮中心 (TERRY AI COMMAND CENTER) v2.0

像素風 RPG 介面 + 7 個 Claude AI agent + **完整 Tool Use 串接** + Agent 互相調度。

![status](https://img.shields.io/badge/status-v2--toolUse-green) ![node](https://img.shields.io/badge/node-20+-blue)

## 📦 v2 新增能力

- ✅ **Tool Use Loop**: agent 真的會「執行工具」,不只是聊天
- ✅ **Agent 互相調度**: 參謀總長能 dispatch_to_agent 派任務給其他 6 個下屬
- ✅ **工作日誌可視化**: 前端展開能看到每個 agent 的完整工作鏈
- ✅ **Mock + Real 雙模式**: 沒設定外部 endpoint 也能跑(假資料),設定後自動切真實

## 📁 專案結構

```
terry-ai-command-center/
├── public/
│   └── index.html        # 像素風前端(單檔, CSS+JS 全內嵌, 含 worklog 視覺化)
├── agents.js             # 7 個 agent 的 system prompt + 工具使用指引
├── tools.js              # 所有工具定義 + 執行邏輯 (連接老闆既有系統的接口)
├── server.js             # Express + Tool Use Loop + 遞迴 dispatch
├── package.json
├── railway.json
├── .env.example          # 完整環境變數範本
└── README.md
```

## 🎮 7 個 Agent + 各自工具

| Emoji | Agent | 工具 | 對應系統 |
|---|---|---|---|
| 🎖 | 參謀總長 | `dispatch_to_agent` | (主控,可調度其他 6 個) |
| 🥷 | 偵察兵 | `query_big_orders` | big-order-scanner |
| 🕵 | 情報官 | `search_news` | monitor.js |
| ⚔ | 戰術官 | `get_positions`, `get_us_counterpart` | 蘿蔔戰情室 |
| 💼 | 軍需官 | `query_pnl` | daikon-dashboard |
| 📡 | 通訊官 | `send_telegram` | Telegram bots |
| 👨‍💻 | 工程師 | `check_deploy_status`, `run_command` | (跨系統) |

## 🔥 殺手級 Demo 場景

老闆對著參謀總長下:**「整理今天戰況」**

實際發生的事:
```
🎖 參謀總長 → dispatch_to_agent("quartermaster", "查 4 月到目前 P&L")
   💼 軍需官 → query_pnl({start: "2026-04-01"})
   💼 軍需官 → 回覆: 4 月累計 +3,612,125
🎖 參謀總長 → dispatch_to_agent("tactician", "目前部位狀況")
   ⚔ 戰術官 → get_positions({account: "all"})
   ⚔ 戰術官 → 回覆: 持有聯電期、聯茂期、啟碁期...
🎖 參謀總長 → dispatch_to_agent("scout", "今日大單")
   🥷 偵察兵 → query_big_orders({})
   🥷 偵察兵 → 回覆: 3 筆大單訊號
🎖 參謀總長 → 整合回覆給老闆: 「老闆,今日戰況如下...」
```

整個過程在前端「工作日誌」展開可見。

## 🚀 部署

### Railway(推薦)

```bash
cd terry-ai-command-center
git init && git add . && git commit -m "init"
gh repo create lobo979005-alt/terry-ai-command-center --private --source=. --push

# Railway → New Project → Deploy from GitHub → 選 repo
# Variables → 至少設 ANTHROPIC_API_KEY
# Settings → Generate Domain
```

### 本機

```bash
npm install
echo "ANTHROPIC_API_KEY=sk-ant-xxx" > .env
node --env-file=.env server.js
# http://localhost:3000
```

## 🔌 串接老闆既有系統

`tools.js` 裡每個 tool 預設走 mock,設定環境變數後切換到真實 endpoint。

### 範例: 軍需官串 daikon-dashboard

老闆現有的 daikon-dashboard 需要暴露這個 endpoint:

```js
// 在老闆 daikon-dashboard 的 server 加:
app.get('/api/pnl', authMiddleware, async (req, res) => {
  const { start, end, account } = req.query;
  const data = await fetchPnLFromGoogleSheets(start, end, account);
  res.json({ period: `${start}~${end}`, account, data });
});
```

然後在 terry-ai-command-center 的 Railway 設:
```
DAIKON_DASHBOARD_URL=https://daikon-dashboard-production.up.railway.app
DAIKON_API_KEY=<你定義的 secret>
```

軍需官下次被派任務查 P&L 時就會走真實資料。

### 範例: 通訊官串 Telegram

```
TG_TOKEN_DANGCHONG=1234567890:ABCdefGHIjklMNOpqrsTUVwxyz
TG_CHAT_DANGCHONG=-1001234567890
```

之後通訊官被派「推一則大單訊號到當沖神器群組」就會真的推。

## 📊 老闆既有系統需要做的調整

| 系統 | 需做的事 | 工程量 |
|---|---|---|
| daikon-dashboard | 加 `/api/pnl` GET endpoint(讀 Google Sheets) | 30 分鐘 |
| big-order-scanner | 加 `/api/signals` GET endpoint(讀記憶體中的 signal queue) | 20 分鐘 |
| monitor.js | 加 HTTP API 包裝(目前是 cron job, 需加 Express) | 1 小時 |
| 蘿蔔戰情室 | 加 `/api/positions`(可從 Google Sheets 讀) | 30 分鐘 |
| Telegram bots | 不用改,直接拿 token 即可 | 0 分鐘 |

## 💰 成本估算

- 純對話(無 tool): Sonnet 4.6 約 $0.005/次
- 用工具(1-2 個 tool): 約 $0.01/次
- 參謀總長調度 3 個下屬: 約 $0.03-0.05/次
- 一天 50 次任務 → 約 $1-2 / 天 (NT$30-60)

工程師建議: 簡單任務(分類、格式化)走 Haiku 4.5,複雜分析走 Opus 4.7。

## 🛠 自訂工具

新增工具流程(以「查除權息」為例):

1. **`tools.js` 加 tool 定義**:
```js
get_dividend: {
  definition: {
    name: 'get_dividend',
    description: '查股票除權息日期與配息',
    input_schema: {
      type: 'object',
      properties: { stock_code: { type: 'string' } },
      required: ['stock_code'],
    },
  },
  execute: async ({ stock_code }, ctx) => {
    // 你的邏輯
    return { stock: stock_code, ex_date: '2026-08-15', dividend: 12.5 };
  },
},
```

2. **`tools.js` 把這個 tool 派給某個 agent**:
```js
export const AGENT_TOOLS = {
  intel: ['search_news', 'get_dividend'],  // 加進來
  // ...
};
```

3. **`agents.js` 在情報官 system prompt 提到**:
```
【可用工具】
- search_news: ...
- get_dividend: 查除權息。被問到「XX 股息多少」時主動使用。
```

重啟 server,情報官就會用了。

## ⚠ 安全考量

- `run_command` 工具**不會自動執行**,只回傳建議指令給老闆手動跑(避免 prompt injection 引發危險)
- `dispatch_to_agent` 有 depth limit (預設 2),避免無限遞迴
- `MAX_TURNS = 8`,防止 agent 被卡在 tool use loop
- 正式部署一定要走後端,瀏覽器直連模式僅供本機測試

## 📋 下一步 Roadmap

1. **持久化** - 對話歷史寫入 SQLite/Volume
2. **密碼登入** - 用老闆既有的 811003
3. **排程任務 (cron)** - 24 小時自動排任務(原 Threads 貼文重點)
4. **Skills 機制** - 模仿 Claude Code skill 載入
5. **多模型策略** - 簡單任務 Haiku, 複雜 Opus
6. **語音輸入** - 操盤時手不離鍵盤

老闆要先做哪一個再講。

— Claude
