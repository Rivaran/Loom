import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { randomUUID } from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  supabase,
  getUserIdByToken,
  getThreads, createThread, archiveThread,
  getRecentMessages, postMessage, deleteMessage,
  getContextCard, upsertContextCard,
  pinMemory, searchMemory,
} from './db.js';

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('./public'));

const sessions = new Map();

function safeTool(fn) {
  return async (args) => {
    try {
      return await fn(args);
    } catch (err) {
      console.error('[tool error]', err.message);
      return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
    }
  };
}

// ─── 認証 ─────────────────────────────────────────────────────────────────────

async function resolveToken(req) {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const valid = await getUserIdByToken(token);
    if (valid) return token;
  }
  const token = req.query.token;
  if (token) {
    const valid = await getUserIdByToken(token);
    if (valid) return token;
  }
  return null;
}

async function apiAuth(req, res) {
  const token = await resolveToken(req);
  if (!token) { res.status(401).json({ error: 'Unauthorized' }); return null; }
  return token;
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

function createMcpServer() {
  const server = new McpServer({ name: 'loom', version: '1.0.0' });

  // create_thread
  server.tool(
    'create_thread',
    'スレッドを新規作成します',
    {
      title: z.string().describe('スレッドのタイトル'),
      tags: z.array(z.string()).optional().describe('タグのリスト'),
    },
    safeTool(async ({ title, tags = [] }) => {
      const thread = await createThread({ title, tags });
      return { content: [{ type: 'text', text: `Thread created: [${thread.id}] ${thread.title}` }] };
    })
  );

  // list_threads
  server.tool(
    'list_threads',
    'スレッド一覧を取得します',
    {
      archived: z.boolean().optional().describe('trueでアーカイブ済みを取得（デフォルトfalse）'),
    },
    safeTool(async ({ archived = false }) => {
      const threads = await getThreads({ archived });
      if (!threads.length) return { content: [{ type: 'text', text: 'スレッドがありません。' }] };
      const lines = threads.map(t => {
        const tags = t.tags?.length ? ` [${t.tags.join(', ')}]` : '';
        return `[${t.id}] ${t.title}${tags} (${t.updated_at?.slice(0, 10)})`;
      });
      return { content: [{ type: 'text', text: `Threads (${threads.length}):\n${lines.join('\n')}` }] };
    })
  );

  // post_message
  server.tool(
    'post_message',
    'スレッドにメッセージを投稿します',
    {
      thread_id: z.string().describe('スレッドID'),
      agent_name: z.string().describe('エージェント名（例: fin, gear, navia）'),
      role: z.enum(['user', 'assistant', 'system']).describe('ロール'),
      content: z.string().describe('メッセージ内容'),
    },
    safeTool(async ({ thread_id, agent_name, role, content }) => {
      const msg = await postMessage({ thread_id, agent_name, role, content });
      return { content: [{ type: 'text', text: `Message posted: [${msg.id}] ${agent_name} (${role})` }] };
    })
  );

  // get_recent_thread
  server.tool(
    'get_recent_thread',
    'スレッドの最近のメッセージを取得します',
    {
      thread_id: z.string().describe('スレッドID'),
      limit: z.number().optional().describe('取得件数（デフォルト50）'),
    },
    safeTool(async ({ thread_id, limit = 50 }) => {
      const messages = await getRecentMessages(thread_id, limit);
      if (!messages.length) return { content: [{ type: 'text', text: 'メッセージがありません。' }] };
      const lines = messages.map(m =>
        `[${m.created_at?.slice(0, 16)}] ${m.agent_name} (${m.role}): ${m.content}`
      );
      return { content: [{ type: 'text', text: lines.join('\n\n') }] };
    })
  );

  // get_context_card
  server.tool(
    'get_context_card',
    'スレッドのコンテキストカードを取得します',
    {
      thread_id: z.string().describe('スレッドID'),
    },
    safeTool(async ({ thread_id }) => {
      const card = await getContextCard(thread_id);
      if (!card) return { content: [{ type: 'text', text: 'コンテキストカードがありません。' }] };
      const lines = [
        card.summary ? `[Summary]\n${card.summary}` : null,
        card.decisions ? `[Decisions]\n${card.decisions}` : null,
        card.open_questions ? `[Open Questions]\n${card.open_questions}` : null,
        card.next_actions ? `[Next Actions]\n${card.next_actions}` : null,
        card.agent_views && Object.keys(card.agent_views).length
          ? `[Agent Views]\n${JSON.stringify(card.agent_views, null, 2)}`
          : null,
      ].filter(Boolean);
      return { content: [{ type: 'text', text: lines.join('\n\n') || '（内容なし）' }] };
    })
  );

  // update_context_card
  server.tool(
    'update_context_card',
    'スレッドのコンテキストカードを更新します',
    {
      thread_id: z.string().describe('スレッドID'),
      summary: z.string().optional().describe('サマリー'),
      decisions: z.string().optional().describe('決定事項'),
      open_questions: z.string().optional().describe('未解決の問い'),
      next_actions: z.string().optional().describe('次のアクション'),
      agent_name: z.string().optional().describe('agent_viewsに書き込むエージェント名'),
      agent_view: z.string().optional().describe('エージェント固有のメモ・視点'),
    },
    safeTool(async ({ thread_id, summary, decisions, open_questions, next_actions, agent_name, agent_view }) => {
      const fields = {};
      if (summary !== undefined) fields.summary = summary;
      if (decisions !== undefined) fields.decisions = decisions;
      if (open_questions !== undefined) fields.open_questions = open_questions;
      if (next_actions !== undefined) fields.next_actions = next_actions;

      if (agent_name && agent_view !== undefined) {
        // 既存のagent_viewsをマージ
        const existing = await getContextCard(thread_id);
        const views = existing?.agent_views || {};
        views[agent_name] = agent_view;
        fields.agent_views = views;
      }

      const card = await upsertContextCard(thread_id, fields);
      return { content: [{ type: 'text', text: `Context card updated for thread [${card.thread_id}]` }] };
    })
  );

  // pin_memory
  server.tool(
    'pin_memory',
    'メモリをピン留めします',
    {
      content: z.string().describe('ピン留めする内容'),
      tags: z.array(z.string()).optional().describe('タグ'),
      thread_id: z.string().optional().describe('関連スレッドID'),
    },
    safeTool(async ({ content, tags = [], thread_id }) => {
      const pin = await pinMemory({ content, tags, thread_id });
      return { content: [{ type: 'text', text: `Memory pinned: [${pin.id}]` }] };
    })
  );

  // search_memory
  server.tool(
    'search_memory',
    'ピン留めメモリを検索します',
    {
      query: z.string().describe('検索クエリ'),
    },
    safeTool(async ({ query }) => {
      const pins = await searchMemory(query);
      if (!pins.length) return { content: [{ type: 'text', text: `"${query}" に一致するメモリがありません。` }] };
      const lines = pins.map(p => {
        const tags = p.tags?.length ? ` [${p.tags.join(', ')}]` : '';
        return `[${p.id}]${tags}\n${p.content}`;
      });
      return { content: [{ type: 'text', text: `Memory (${pins.length}件):\n\n${lines.join('\n\n')}` }] };
    })
  );

  return server;
}

// ─── MCP HTTP Endpoints ───────────────────────────────────────────────────────

app.post('/mcp', async (req, res) => {
  try {
    const sessionId = req.headers['mcp-session-id'];
    let transport;
    if (sessionId && sessions.has(sessionId)) {
      transport = sessions.get(sessionId);
    } else if (isInitializeRequest(req.body)) {
      const token = await resolveToken(req);
      if (!token) { res.status(401).json({ error: 'Unauthorized: valid token required' }); return; }
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => { sessions.set(sid, transport); },
      });
      transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
      await createMcpServer().connect(transport);
    } else {
      res.status(400).json({ error: 'Bad Request: invalid or missing session' }); return;
    }
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('[MCP POST error]', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/mcp', async (req, res) => {
  try {
    const sessionId = req.headers['mcp-session-id'];
    if (!sessionId || !sessions.has(sessionId)) { res.status(400).json({ error: 'Bad Request' }); return; }
    await sessions.get(sessionId).handleRequest(req, res);
  } catch (err) {
    console.error('[MCP GET error]', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/mcp', async (req, res) => {
  try {
    const sessionId = req.headers['mcp-session-id'];
    if (!sessionId || !sessions.has(sessionId)) { res.status(400).json({ error: 'Bad Request' }); return; }
    const transport = sessions.get(sessionId);
    await transport.handleRequest(req, res);
    sessions.delete(sessionId);
  } catch (err) {
    console.error('[MCP DELETE error]', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── JWT認証（UI用） ──────────────────────────────────────────────────────────

async function verifyJwt(req, res) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) { res.status(401).json({ error: 'Unauthorized' }); return null; }
  const jwt = authHeader.slice(7);
  const { data: { user }, error } = await supabase.auth.getUser(jwt);
  if (error || !user) { res.status(401).json({ error: 'Unauthorized' }); return null; }
  return user;
}

// ─── REST API ─────────────────────────────────────────────────────────────────

// GET /api/config（Supabase公開情報）
app.get('/api/config', (req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
  });
});

// GET /api/auth/token（トークン一覧）
app.get('/api/auth/token', async (req, res) => {
  const user = await verifyJwt(req, res); if (!user) return;
  const { data, error } = await supabase
    .from('loom_api_tokens')
    .select('id, label, created_at')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/auth/token（トークン発行）
app.post('/api/auth/token', async (req, res) => {
  const user = await verifyJwt(req, res); if (!user) return;
  const { label } = req.body;
  const { data, error } = await supabase
    .from('loom_api_tokens')
    .insert({ label: label || null })
    .select('id, label, created_at')
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// DELETE /api/auth/token/:id（トークン削除）
app.delete('/api/auth/token/:id', async (req, res) => {
  const user = await verifyJwt(req, res); if (!user) return;
  const { error } = await supabase
    .from('loom_api_tokens')
    .delete()
    .eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// GET /api/threads
app.get('/api/threads', async (req, res) => {
  const token = await apiAuth(req, res); if (!token) return;
  const archived = req.query.archived === 'true';
  res.json(await getThreads({ archived }));
});

// POST /api/threads
app.post('/api/threads', async (req, res) => {
  const token = await apiAuth(req, res); if (!token) return;
  const { title, tags } = req.body;
  if (!title) return res.status(400).json({ error: 'title is required' });
  res.json(await createThread({ title, tags }));
});

// GET /api/threads/:id/messages
app.get('/api/threads/:id/messages', async (req, res) => {
  const token = await apiAuth(req, res); if (!token) return;
  const limit = Number(req.query.limit) || 50;
  res.json(await getRecentMessages(req.params.id, limit));
});

// POST /api/threads/:id/messages
app.post('/api/threads/:id/messages', async (req, res) => {
  const token = await apiAuth(req, res); if (!token) return;
  const { agent_name, role, content } = req.body;
  if (!agent_name || !role || !content) return res.status(400).json({ error: 'agent_name, role, content are required' });
  res.json(await postMessage({ thread_id: req.params.id, agent_name, role, content }));
});

// GET /api/threads/:id/context
app.get('/api/threads/:id/context', async (req, res) => {
  const token = await apiAuth(req, res); if (!token) return;
  const card = await getContextCard(req.params.id);
  res.json(card || {});
});

// PUT /api/threads/:id/context
app.put('/api/threads/:id/context', async (req, res) => {
  const token = await apiAuth(req, res); if (!token) return;
  res.json(await upsertContextCard(req.params.id, req.body));
});

// GET /api/memory-pins
app.get('/api/memory-pins', async (req, res) => {
  const token = await apiAuth(req, res); if (!token) return;
  const query = req.query.q || '';
  if (query) {
    res.json(await searchMemory(query));
  } else {
    const { data, error } = await supabase
      .from('memory_pins')
      .select('id, thread_id, content, tags, created_at')
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  }
});

// POST /api/memory-pins
app.post('/api/memory-pins', async (req, res) => {
  const token = await apiAuth(req, res); if (!token) return;
  const { content, tags, thread_id } = req.body;
  if (!content) return res.status(400).json({ error: 'content is required' });
  res.json(await pinMemory({ content, tags, thread_id }));
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => console.log(`Loom running on port ${PORT}`));
