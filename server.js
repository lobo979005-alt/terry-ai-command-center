// server.js - TERRY AI COMMAND CENTER 後端 (v2 - Tool Use 版)
//
// 新增能力:
//   - Tool Use multi-turn loop
//   - Agent 互相調度 (chief 可派任務給其他 6 個 agent)
//   - 工作日誌 workLog (前端可顯示 agent 在做什麼)
//
// 部署: Railway / Zeabur
// 必填環境變數: ANTHROPIC_API_KEY
// 選填環境變數(讓 tool 走真實 endpoint): 見 .env.example

import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';
import { fileURLToPath } from 'url';
import path from 'path';
import { AGENTS } from './agents.js';
import { getToolsForAgent, executeTool } from './tools.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ====== 定價表 (USD per 1M tokens) ======
const PRICING = {
  'claude-opus-4-7':    { input: 15.00, output: 75.00 },
  'claude-sonnet-4-6':  { input:  3.00, output: 15.00 },
  'claude-haiku-4-5':   { input:  1.00, output:  5.00 },
};

function calcCost(model, usage) {
  const p = PRICING[model] || { input: 3, output: 15 };
  return (usage.input_tokens * p.input + usage.output_tokens * p.output) / 1_000_000;
}

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ====== 健康檢查 ======
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    agents: AGENTS.length,
    hasKey: !!process.env.ANTHROPIC_API_KEY,
    time: new Date().toISOString(),
    version: '2.0-toolUse',
  });
});

// ====== 列出所有 agent ======
app.get('/api/agents', (req, res) => {
  res.json(AGENTS.map(a => ({
    id: a.id, name: a.name, role: a.role, emoji: a.emoji,
    tools: (getToolsForAgent(a.id) || []).map(t => t.name),
  })));
});

// ====== 取得台北今日日期 (yyyy-mm-dd, 不受 server timezone 影響) ======
function getTaipeiToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
}

// ====== 核心: dispatch with tool use loop ======
async function dispatchAgent({ agentId, model, messages, depth = 0, triggeredBy = null, workLog = [] }) {
  const agent = AGENTS.find(a => a.id === agentId);
  if (!agent) throw new Error(`agent not found: ${agentId}`);

  const tools = getToolsForAgent(agentId);
  const today = getTaipeiToday();
  const systemPrompt = `${agent.systemPrompt}\n\n【系統注入】今日日期: ${today} (台北時區)。所有日期相關推理必須以此為準,不可使用模型內部的日期推測。`;
  let workingMessages = [...messages];
  let totalCost = 0;
  let turnCount = 0;
  const MAX_TURNS = 8; // 防止無限呼叫工具

  workLog.push({
    type: 'agent_start',
    agent: agent.id,
    name: agent.name,
    emoji: agent.emoji,
    depth,
    triggeredBy,
    time: new Date().toISOString(),
  });

  while (turnCount < MAX_TURNS) {
    turnCount++;

    const response = await anthropic.messages.create({
      model,
      max_tokens: 2048,
      system: systemPrompt,
      messages: workingMessages,
      ...(tools.length > 0 ? { tools } : {}),
    });

    totalCost += calcCost(model, response.usage);
    workLog.push({
      type: 'turn',
      agent: agent.id,
      turn: turnCount,
      stop_reason: response.stop_reason,
      usage: response.usage,
    });

    // ====== 沒有工具呼叫,直接回覆 ======
    if (response.stop_reason === 'end_turn' || response.stop_reason === 'max_tokens') {
      const textBlock = response.content.find(c => c.type === 'text');
      const reply = textBlock ? textBlock.text : '(無回覆)';
      workLog.push({
        type: 'agent_reply',
        agent: agent.id,
        reply: reply.slice(0, 100) + (reply.length > 100 ? '...' : ''),
      });
      return { reply, cost: totalCost, workLog };
    }

    // ====== 工具呼叫 ======
    if (response.stop_reason === 'tool_use') {
      const toolUseBlocks = response.content.filter(c => c.type === 'tool_use');

      // assistant message 必須完整加進歷史
      workingMessages.push({ role: 'assistant', content: response.content });

      // 執行所有 tool
      const toolResults = [];
      for (const block of toolUseBlocks) {
        workLog.push({
          type: 'tool_call',
          agent: agent.id,
          tool: block.name,
          input: block.input,
        });

        try {
          const result = await executeTool(block.name, block.input, {
            depth,
            currentAgentId: agent.id,
            model,
            anthropic,
            // 把 dispatch 函式注入,讓 dispatch_to_agent 能遞迴呼叫
            dispatch: async (params) => dispatchAgent({ ...params, workLog }),
          });

          workLog.push({
            type: 'tool_result',
            agent: agent.id,
            tool: block.name,
            result_preview: JSON.stringify(result).slice(0, 300),
          });

          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
          });
        } catch (e) {
          workLog.push({
            type: 'tool_error',
            agent: agent.id,
            tool: block.name,
            error: e.message,
          });
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: `Error: ${e.message}`,
            is_error: true,
          });
        }
      }

      workingMessages.push({ role: 'user', content: toolResults });
      // continue loop - 讓 Claude 看 tool result 後決定下一步
      continue;
    }

    // ====== 其他 stop_reason ======
    workLog.push({ type: 'unexpected_stop', stop_reason: response.stop_reason });
    return {
      reply: response.content.find(c => c.type === 'text')?.text || '(意外結束)',
      cost: totalCost,
      workLog,
    };
  }

  return {
    reply: `⚠ 達到最大回合數 (${MAX_TURNS}),強制結束`,
    cost: totalCost,
    workLog,
  };
}

// ====== 派任務 endpoint ======
app.post('/api/dispatch', async (req, res) => {
  const { agentId, model = 'claude-sonnet-4-6', messages } = req.body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages required' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY 環境變數未設定' });
  }

  try {
    console.log(`[dispatch] agent=${agentId} model=${model} msgs=${messages.length}`);

    const result = await dispatchAgent({ agentId, model, messages });

    const turns = result.workLog.filter(l => l.type === 'turn').length;
    const toolCalls = result.workLog.filter(l => l.type === 'tool_call').length;
    console.log(`[dispatch] ${agentId} done cost=$${result.cost.toFixed(4)} turns=${turns} tools=${toolCalls}`);

    res.json({
      reply: result.reply,
      agentId,
      model,
      cost: Number(result.cost.toFixed(6)),
      workLog: result.workLog,
    });
  } catch (err) {
    console.error('[dispatch] error:', err.message, err.stack);
    res.status(500).json({
      error: err.message || 'unknown error',
      type: err.type,
    });
  }
});

// ====== fallback ======
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════╗
║   ⚔  TERRY AI COMMAND CENTER  v2.0  ⚔                  ║
║   泰瑞 AI 軍團 指揮中心  (Tool Use 版)  已啟動           ║
║                                                        ║
║   Port:   ${String(PORT).padEnd(48)}║
║   Agents: ${String(AGENTS.length).padEnd(48)}║
║   Key:    ${(process.env.ANTHROPIC_API_KEY ? '✓ loaded' : '✗ MISSING - set ANTHROPIC_API_KEY').padEnd(48)}║
║                                                        ║
║   [Tools] dispatch_to_agent · query_big_orders         ║
║           search_news · get_positions · query_pnl      ║
║           send_telegram · check_deploy_status          ║
╚════════════════════════════════════════════════════════╝
  `);
});
