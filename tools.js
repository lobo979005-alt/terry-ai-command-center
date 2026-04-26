// tools.js - 所有 agent 可用的工具
//
// 每個 tool 有兩部分:
//   1. definition - 給 Claude 看的 schema
//   2. execute - 實際執行邏輯
//
// 大多數 tool 預設走 mock(回假資料),老闆設定環境變數後會自動切換到真實 endpoint。

import { AGENTS } from './agents.js';

// ============================================================
//  HTTP helper - 統一的 fetch with timeout
// ============================================================
async function httpJson(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// ============================================================
//  TOOL DEFINITIONS
// ============================================================
export const TOOLS = {

  // ─────────────────────────────────────────────
  //  CHIEF (參謀總長) - 派任務給其他 agent
  // ─────────────────────────────────────────────
  dispatch_to_agent: {
    definition: {
      name: 'dispatch_to_agent',
      description: '把任務派給軍團裡其他 agent 執行,並取得他們的回覆。用於需要其他職能專家處理的任務。',
      input_schema: {
        type: 'object',
        properties: {
          agent_id: {
            type: 'string',
            enum: ['scout', 'intel', 'tactician', 'quartermaster', 'comms', 'engineer'],
            description: '目標 agent ID。scout=偵察兵, intel=情報官, tactician=戰術官, quartermaster=軍需官, comms=通訊官, engineer=工程師',
          },
          task: {
            type: 'string',
            description: '要交辦的具體任務內容',
          },
          context: {
            type: 'string',
            description: '背景資訊(選填)',
          },
        },
        required: ['agent_id', 'task'],
      },
    },
    execute: async ({ agent_id, task, context }, ctx) => {
      if (ctx.depth >= 2) {
        return { error: '已達 agent 派遣深度上限(避免無限循環)' };
      }
      const fullTask = context ? `【背景】${context}\n\n【任務】${task}` : task;
      // 遞迴呼叫 dispatch
      const result = await ctx.dispatch({
        agentId: agent_id,
        model: ctx.model,
        messages: [{ role: 'user', content: fullTask }],
        depth: ctx.depth + 1,
        triggeredBy: ctx.currentAgentId,
      });
      const targetAgent = AGENTS.find(a => a.id === agent_id);
      return {
        from: targetAgent ? `${targetAgent.emoji} ${targetAgent.name}` : agent_id,
        reply: result.reply,
        cost: result.cost,
      };
    },
  },

  // ─────────────────────────────────────────────
  //  SCOUT (偵察兵) - 大單偵測
  // ─────────────────────────────────────────────
  query_big_orders: {
    definition: {
      name: 'query_big_orders',
      description: '查詢 big-order-scanner 系統當前偵測到的大單訊號。回傳今日已觸發的大單列表。',
      input_schema: {
        type: 'object',
        properties: {
          stock_code: { type: 'string', description: '股票代號(選填)。不填則回所有大單。' },
          min_amount: { type: 'number', description: '最小金額過濾(NT$,選填,預設 5,000,000)' },
        },
      },
    },
    execute: async ({ stock_code, min_amount = 5_000_000 }, ctx) => {
      const url = process.env.BIG_ORDER_SCANNER_URL;
      if (url) {
        try {
          return await httpJson(`${url}/api/signals?min=${min_amount}${stock_code ? `&code=${stock_code}` : ''}`);
        } catch (e) {
          return { error: `big-order-scanner 連線失敗: ${e.message}`, hint: '檢查 BIG_ORDER_SCANNER_URL 是否正確' };
        }
      }
      // MOCK
      return {
        _mock: true,
        _hint: '設定環境變數 BIG_ORDER_SCANNER_URL 後會切換到真實資料',
        signals: stock_code ? [
          { time: '10:23:14', code: stock_code, name: 'Mock', amount: 18_500_000, price_change: '+2.3%' },
        ] : [
          { time: '09:32:08', code: '2330', name: '台積電', amount: 25_300_000, price_change: '+1.2%' },
          { time: '10:15:42', code: '2303', name: '聯電',  amount: 18_700_000, price_change: '+2.8%' },
          { time: '10:48:21', code: '6488', name: '環球晶', amount: 12_400_000, price_change: '+1.9%' },
        ],
      };
    },
  },

  // ─────────────────────────────────────────────
  //  INTEL (情報官) - 個股新聞
  // ─────────────────────────────────────────────
  search_news: {
    definition: {
      name: 'search_news',
      description: '搜尋個股相關新聞。預設過濾 13:30 後的當日新聞(收盤後新聞)。',
      input_schema: {
        type: 'object',
        properties: {
          stock_code: { type: 'string', description: '股票代號或公司名稱' },
          hours_back: { type: 'number', description: '往前查幾小時(選填,預設 24)' },
          after_market_close: { type: 'boolean', description: '是否只查收盤後新聞(13:30 後)' },
        },
        required: ['stock_code'],
      },
    },
    execute: async ({ stock_code, hours_back = 24, after_market_close = false }, ctx) => {
      const url = process.env.MONITOR_API_URL;
      if (url) {
        try {
          return await httpJson(`${url}/api/news?code=${stock_code}&hours=${hours_back}&after_close=${after_market_close}`);
        } catch (e) {
          return { error: `monitor.js API 連線失敗: ${e.message}` };
        }
      }
      // MOCK
      return {
        _mock: true,
        _hint: '設定 MONITOR_API_URL 後會切換到 monitor.js 真實資料',
        stock: stock_code,
        articles: [
          { title: `${stock_code} 重訊:法人加碼買進`, time: '14:32', source: '經濟日報' },
          { title: `${stock_code} 第三季營收年增 18%`, time: '13:45', source: 'MoneyDJ' },
        ],
      };
    },
  },

  // ─────────────────────────────────────────────
  //  TACTICIAN (戰術官) - 部位 / US 對映
  // ─────────────────────────────────────────────
  get_positions: {
    definition: {
      name: 'get_positions',
      description: '取得當前持倉部位(跨所有帳戶: 兆豐 / 群益 / 元富 / 統一 / 期貨帳)',
      input_schema: {
        type: 'object',
        properties: {
          account: { type: 'string', enum: ['all', '兆豐', '群益', '元富', '統一', '期貨帳'] },
        },
      },
    },
    execute: async ({ account = 'all' }, ctx) => {
      const url = process.env.WAR_ROOM_URL;
      if (url) {
        try {
          return await httpJson(`${url}/api/positions?account=${encodeURIComponent(account)}`);
        } catch (e) {
          return { error: `war room 連線失敗: ${e.message}` };
        }
      }
      // MOCK - 用 user memory 裡的真實持股名單
      return {
        _mock: true,
        _hint: '設定 WAR_ROOM_URL 後會接到蘿蔔戰情室即時部位',
        positions: [
          { code: '聯電期', shares: 5, avg_cost: 50.2, market_value: 252000 },
          { code: '聯茂期', shares: 3, avg_cost: 89.5, market_value: 270000 },
          { code: '啟碁期', shares: 2, avg_cost: 142, market_value: 285000 },
          { code: '南電期', shares: 4, avg_cost: 178, market_value: 718000 },
          { code: '台指04F3 put', shares: 1, avg_cost: 35, market_value: 7000 },
        ],
      };
    },
  },

  get_us_counterpart: {
    definition: {
      name: 'get_us_counterpart',
      description: '查台股對應的美股 ADR / 同類股,用於評估隔日開盤風險。',
      input_schema: {
        type: 'object',
        properties: {
          taiwan_stock: { type: 'string', description: '台股代號或名稱' },
        },
        required: ['taiwan_stock'],
      },
    },
    execute: async ({ taiwan_stock }, ctx) => {
      // 內建映射表(從 user memory)
      const map = {
        '台積電': 'TSM', '2330': 'TSM',
        '聯電': 'UMC', '2303': 'UMC',
        '美光': 'MU',
        '日月光': 'AMKR', '3711': 'AMKR',
        'ONTO': 'ONTO',
        'MPWR': 'MPWR',
        '矽力-KY': 'MPWR',
      };
      const ticker = map[taiwan_stock];
      return {
        taiwan: taiwan_stock,
        us_ticker: ticker || 'unknown',
        risk_level: ticker === 'UMC' ? '⚠ HIGH (UMC ADR 背離追蹤中)' : 'normal',
        last_close: ticker ? { price: '50.23', change: '+1.8%', _mock: true } : null,
      };
    },
  },

  // ─────────────────────────────────────────────
  //  QUARTERMASTER (軍需官) - P&L
  // ─────────────────────────────────────────────
  query_pnl: {
    definition: {
      name: 'query_pnl',
      description: '查詢損益。可指定日期範圍與帳戶。回傳數字必須是 daikon-dashboard 同步的真實值,不可推算。',
      input_schema: {
        type: 'object',
        properties: {
          start_date: { type: 'string', description: 'YYYY-MM-DD' },
          end_date: { type: 'string', description: 'YYYY-MM-DD' },
          account: { type: 'string', enum: ['all', 'stocks', 'futures', '兆豐', '群益', '元富', '統一', '期貨帳'] },
        },
      },
    },
    execute: async ({ start_date, end_date, account = 'all' }, ctx) => {
      const url = process.env.DAIKON_DASHBOARD_URL || 'https://daikon-dashboard-production.up.railway.app';
      if (process.env.DAIKON_API_KEY) {
        try {
          return await httpJson(
            `${url}/api/pnl?start=${start_date}&end=${end_date}&account=${account}`,
            { headers: { 'Authorization': `Bearer ${process.env.DAIKON_API_KEY}` } }
          );
        } catch (e) {
          return { error: `daikon-dashboard 連線失敗: ${e.message}`, fallback: '改用 mock 資料' };
        }
      }
      // MOCK - 用 user memory 裡的 2026 真實累計
      return {
        _mock: true,
        _hint: '設定 DAIKON_DASHBOARD_URL + DAIKON_API_KEY 後會接 daikon 真實資料',
        period: `${start_date || '2026-01-01'} ~ ${end_date || '2026-04-10'}`,
        account,
        data: {
          monthly: {
            '2026-01': 2_402_044,
            '2026-02': 1_538_881,
            '2026-03': 1_821_925,
            '2026-04': 3_612_125,
          },
          cumulative: 9_374_971,
          trading_days: 58,
          march_breakdown: {
            '兆豐(股票)': 1_422_155,
            '統一(期貨)': 1_359_187,
            '群益(股票)': 34_116,
            '期貨帳': -1_035_009,
            '帳務調整': 41_476,
          },
        },
      };
    },
  },

  // ─────────────────────────────────────────────
  //  COMMS (通訊官) - Telegram
  // ─────────────────────────────────────────────
  send_telegram: {
    definition: {
      name: 'send_telegram',
      description: '推播訊息到指定 Telegram 群組或 bot。',
      input_schema: {
        type: 'object',
        properties: {
          channel: {
            type: 'string',
            enum: ['LOBOMoney', 'lobo_ai_assistant', 'DangChong_Shenqi'],
            description: 'LOBOMoney=monitor 推播,lobo_ai_assistant=AI 助理,DangChong_Shenqi=當沖神器',
          },
          message: { type: 'string', description: '訊息內容(支援 MarkdownV2)' },
        },
        required: ['channel', 'message'],
      },
    },
    execute: async ({ channel, message }, ctx) => {
      const tokenMap = {
        'LOBOMoney': process.env.TG_TOKEN_LOBOMONEY,
        'lobo_ai_assistant': process.env.TG_TOKEN_AI_ASSISTANT,
        'DangChong_Shenqi': process.env.TG_TOKEN_DANGCHONG,
      };
      const chatIdMap = {
        'LOBOMoney': process.env.TG_CHAT_LOBOMONEY,
        'lobo_ai_assistant': process.env.TG_CHAT_AI_ASSISTANT,
        'DangChong_Shenqi': process.env.TG_CHAT_DANGCHONG,
      };
      const token = tokenMap[channel];
      const chatId = chatIdMap[channel];
      if (!token || !chatId) {
        return {
          _mock: true,
          _hint: `設定環境變數 TG_TOKEN_${channel.toUpperCase()} + TG_CHAT_${channel.toUpperCase()} 後會真實推播`,
          would_send: { channel, message },
        };
      }
      try {
        const res = await httpJson(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'MarkdownV2' }),
        });
        return { sent: true, message_id: res.result?.message_id };
      } catch (e) {
        return { error: `Telegram 推播失敗: ${e.message}` };
      }
    },
  },

  // ─────────────────────────────────────────────
  //  ENGINEER (工程師) - 部署狀態
  // ─────────────────────────────────────────────
  check_deploy_status: {
    definition: {
      name: 'check_deploy_status',
      description: '檢查 Railway / Zeabur 上某個服務的部署狀態。',
      input_schema: {
        type: 'object',
        properties: {
          service: {
            type: 'string',
            enum: ['big-order-scanner', 'daikon-dashboard', 'telegram-assistant', 'monitor', 'all'],
          },
        },
        required: ['service'],
      },
    },
    execute: async ({ service }, ctx) => {
      // 簡單 ping 各服務的 health endpoint
      const services = {
        'big-order-scanner': process.env.BIG_ORDER_SCANNER_URL,
        'daikon-dashboard': process.env.DAIKON_DASHBOARD_URL || 'https://daikon-dashboard-production.up.railway.app',
        'telegram-assistant': process.env.TELEGRAM_ASSISTANT_URL,
        'monitor': process.env.MONITOR_API_URL,
      };
      const targets = service === 'all' ? Object.keys(services) : [service];
      const results = {};
      for (const s of targets) {
        const url = services[s];
        if (!url) {
          results[s] = { status: 'unknown', _hint: `環境變數未設定 URL` };
          continue;
        }
        try {
          const start = Date.now();
          const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(5000) });
          results[s] = {
            status: res.ok ? '✓ online' : `✗ ${res.status}`,
            response_time_ms: Date.now() - start,
            url,
          };
        } catch (e) {
          results[s] = { status: '✗ unreachable', error: e.message, url };
        }
      }
      return results;
    },
  },

  run_command: {
    definition: {
      name: 'run_command',
      description: '提示使用者執行 shell 指令(不會自動跑,只回傳建議指令給老闆手動執行)。',
      input_schema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '建議的指令' },
          purpose: { type: 'string', description: '這個指令要做什麼' },
          warning: { type: 'string', description: '需要注意的事項' },
        },
        required: ['command', 'purpose'],
      },
    },
    execute: async ({ command, purpose, warning }, ctx) => {
      // 出於安全,我們不自動執行,而是回傳建議讓老闆手動跑
      return {
        suggestion_only: true,
        command,
        purpose,
        warning: warning || null,
        instruction: '請老闆檢查後在自己的終端機執行',
      };
    },
  },
};

// ============================================================
//  AGENT ↔ TOOLS 對應表
// ============================================================
export const AGENT_TOOLS = {
  chief:         ['dispatch_to_agent'],
  scout:         ['query_big_orders'],
  intel:         ['search_news'],
  tactician:     ['get_positions', 'get_us_counterpart'],
  quartermaster: ['query_pnl'],
  comms:         ['send_telegram'],
  engineer:      ['check_deploy_status', 'run_command'],
};

// ============================================================
//  取得指定 agent 可用的 tool definitions
// ============================================================
export function getToolsForAgent(agentId) {
  const toolNames = AGENT_TOOLS[agentId] || [];
  return toolNames.map(n => TOOLS[n].definition);
}

// ============================================================
//  執行單一 tool call
// ============================================================
export async function executeTool(toolName, input, ctx) {
  const tool = TOOLS[toolName];
  if (!tool) throw new Error(`unknown tool: ${toolName}`);
  return await tool.execute(input, ctx);
}
