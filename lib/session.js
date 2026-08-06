// 接个话 — 会话读取模块
// 从会话 JSONL 尾部读最近消息（给推荐生成提供上下文）
// 会话定位优先用工具 ctx 的 sessionId/sessionPath（runtimeScope 展开），兜底扫描最近会话文件

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const HANA_HOME = process.env.HANA_HOME || path.join(os.homedir(), ".hanako");

// ─── 从 JSONL 尾部读最近 N 条有效消息（user/assistant） ───
export function readRecentMessages(sessionPath, max = 6) {
  try {
    if (!sessionPath || !fs.existsSync(sessionPath)) return [];
    const stat = fs.statSync(sessionPath);
    if (stat.size === 0) return [];

    // 只读文件尾部（最多 256KB），避免大会话全量读
    const TAIL = 256 * 1024;
    const fd = fs.openSync(sessionPath, "r");
    let buffer;
    try {
      const start = Math.max(0, stat.size - TAIL);
      buffer = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
    } finally {
      fs.closeSync(fd);
    }

    const lines = buffer.toString("utf-8").split("\n").filter(Boolean);
    const messages = [];
    for (let i = lines.length - 1; i >= 0 && messages.length < max; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.role !== "user" && entry.role !== "assistant") continue;
        const content = typeof entry.content === "string" ? entry.content : "";
        if (!content.trim()) continue;
        messages.unshift({ role: entry.role, content: content.slice(0, 500) });
      } catch {}
    }
    return messages;
  } catch (err) {
    console.error("[接个话] 读取会话失败:", err?.message || err);
    return [];
  }
}

// ─── 提取 prompt 上下文：清洗噪音（MOOD 块/引用块）+ 截断，只留干净的对话 ───
// 实机教训（2026-08-06）：不清理就把 MOOD/<mood> 块、[hana_reference] 引用喂给模型，
// 模型会被第一人称内容带偏，分不清「用户」是谁，生成助手口吻的推荐。
export function buildContextText(messages) {
  if (!messages.length) return "";
  const parts = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    let text = typeof m.content === "string" ? m.content : "";
    text = cleanContextText(text);
    if (!text) continue;
    parts.push(`${m.role === "user" ? "用户" : "助手"}: ${text}`);
  }
  // 只保留最近 4 条，太长会稀释推荐质量
  return parts.slice(-4).join("\n");
}

function cleanContextText(text) {
  let out = text || "";
  // 去 <mood>...</mood> 块
  out = out.replace(/<mood>[\s\S]*?<\/mood>/gi, "");
  // 去 [xxx] 引用块（如 [hana_reference]...[/hana_reference]）
  out = out.replace(/\[[^\]]*\][\s\S]*?\[\/[^\]]*\]/gi, "");
  // 去单行 [xxx] 标记
  out = out.replace(/\[[^\]]*\]/g, "");
  // 去成对的【xxx】...【/xxx】隐藏注入块
  out = out.replace(/【[^】]*】[\s\S]*?【\/[^】]*】/g, "");
  // 去隐藏注入块（【朋友圈生活视角】等，兜底到行尾）
  out = out.replace(/【[^】]*】[\s\S]*?(?=(用户|助手):|$)/g, "");
  out = out.replace(/\s+/g, " ").trim();
  // 每条最多 250 字（v0.2 提升：保留更多对话细节供推荐参考）
  return out.slice(0, 250);
}

// ─── 兜底：按 agentId 找最近会话文件（闲不住同款） ───
export function findLatestSessionPath(agentId) {
  try {
    const sessionsDir = path.join(HANA_HOME, "agents", agentId, "sessions");
    if (!fs.existsSync(sessionsDir)) return "";
    const files = fs
      .readdirSync(sessionsDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => {
        const fp = path.join(sessionsDir, f);
        try { return { fp, mtime: fs.statSync(fp).mtimeMs }; } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);
    return files.length ? files[0].fp : "";
  } catch {
    return "";
  }
}
