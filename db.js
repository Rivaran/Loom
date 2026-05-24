import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ── 認証 ─────────────────────────────────────────────────────────────────────

export async function verifyJwt(jwt) {
  const { data: { user }, error } = await supabase.auth.getUser(jwt);
  if (error || !user) return null;
  return user.id;
}

/** APIトークンが存在すればtrueを返す（共有ワークスペース、user_idなし） */
export async function getUserIdByToken(token) {
  const { data, error } = await supabase
    .from('loom_api_tokens')
    .select('id')
    .eq('id', token)
    .maybeSingle();
  if (error || !data) return null;
  return true;
}

// ── Thread ────────────────────────────────────────────────────────────────────

export async function getThreads({ archived = false } = {}) {
  const { data, error } = await supabase
    .from('threads')
    .select('id, title, tags, archived, created_at, updated_at')
    .eq('archived', archived)
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return data;
}

export async function createThread({ title, tags = [] }) {
  const { data, error } = await supabase
    .from('threads')
    .insert({ title, tags })
    .select('id, title, tags, archived, created_at, updated_at')
    .single();
  if (error) throw error;
  return data;
}

export async function archiveThread(id) {
  const { data, error } = await supabase
    .from('threads')
    .update({ archived: true, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('id, title, archived')
    .single();
  if (error) throw error;
  return data;
}

// ── Message ───────────────────────────────────────────────────────────────────

export async function getRecentMessages(threadId, limit = 50) {
  const { data, error } = await supabase
    .from('messages')
    .select('id, thread_id, agent_name, role, content, created_at')
    .eq('thread_id', threadId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data.reverse();
}

export async function postMessage({ thread_id, agent_name, role, content }) {
  const { data, error } = await supabase
    .from('messages')
    .insert({ thread_id, agent_name, role, content })
    .select('id, thread_id, agent_name, role, content, created_at')
    .single();
  if (error) throw error;
  // スレッドのupdated_atを更新
  await supabase
    .from('threads')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', thread_id);
  return data;
}

export async function deleteMessage(id) {
  const { error } = await supabase
    .from('messages')
    .delete()
    .eq('id', id);
  if (error) throw error;
}

// ── Context Card ──────────────────────────────────────────────────────────────

export async function getContextCard(threadId) {
  const { data, error } = await supabase
    .from('context_cards')
    .select('id, thread_id, summary, decisions, open_questions, next_actions, agent_views, updated_at')
    .eq('thread_id', threadId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function upsertContextCard(threadId, fields) {
  const allowed = ['summary', 'decisions', 'open_questions', 'next_actions', 'agent_views'];
  const update = Object.fromEntries(Object.entries(fields).filter(([k]) => allowed.includes(k)));
  update.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from('context_cards')
    .upsert({ thread_id: threadId, ...update }, { onConflict: 'thread_id' })
    .select('id, thread_id, summary, decisions, open_questions, next_actions, agent_views, updated_at')
    .single();
  if (error) throw error;
  return data;
}

// ── Memory Pin ────────────────────────────────────────────────────────────────

export async function pinMemory({ content, tags = [], thread_id = null }) {
  const { data, error } = await supabase
    .from('memory_pins')
    .insert({ content, tags, thread_id: thread_id || null })
    .select('id, thread_id, content, tags, created_at')
    .single();
  if (error) throw error;
  return data;
}

export async function searchMemory(query) {
  // テキスト部分一致でシンプル検索（ilike）
  const { data, error } = await supabase
    .from('memory_pins')
    .select('id, thread_id, content, tags, created_at')
    .ilike('content', `%${query}%`)
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) throw error;
  return data;
}
