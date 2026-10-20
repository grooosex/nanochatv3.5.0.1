import { COOLDOWN_MS } from "./constants.ts";
import { generateNai, imageFailText, writeImageTags } from "./engine.ts";
import { grokOnce } from "./grok-client.ts";
import { blobDataUrl } from "./ref-image.ts";
import { useApp } from "./store.ts";
import type { Chat, WechatAttach, WechatLine, WechatSession } from "./types.ts";
import { uid } from "./utils.ts";

type Part = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

const REPLY_SYSTEM = `你在和用户用手机微信聊天。你就是角色本人，坐在手机前面打字。你知道这是微信，不是面对面说话。

气泡里只写她发出去的话。不要写环境、动作、心理、旁白、摘要。
一次一到三条。至少一条里要有汉字，不能只有表情符号。每条通常一句，不超过 40 个字。一句够就一条，不要拆开凑数。
Emoji 可以视情况写进文字里，不是每条都要。
表情包不是每次都要。没有发给你的表情包列表时，不要发，sticker 填 0。有列表时看情况选一张，不合适就填 0。

inner 是屏幕对面的她这一拍：手里在干什么、脸上什么表情、心里怎么想。和这几条消息同时发生。大约四到八句。不要把剧情再往前演，不要把气泡里的话重抄一遍。

只返回一个 JSON，不要 markdown，不要解释：
{"bubbles":["一条文字"],"inner":"内心","sticker":0}`;

const FOLD_SYSTEM = `把下面这段微信压成一份简短记录，给后面的微信接着用。保留说定的事、关系和现在停在哪。不要写成小说。不要引用内心。只输出正文。`;

const SUMMARY_SYSTEM = `你在给一段手机微信写总结，给主聊天的正文接着用。
你可以看内心，用来理解她当时的态度，但写出来的总结不要抄内心，不要写她没说出口的心理和只有你看得到的小动作。
只写微信上说定的事：定了什么、关系怎样、停在哪。提到她发过的照片时用一句话带过。
不要用书名号，不要用括号。只输出总结正文。`;

export function emptyWechatSession(charId: string): WechatSession {
  return { charId, lines: [], earlier: "", draft: "", pending: [], armed: false };
}

export function wechatTurnText(summary: string) {
  const s = summary.trim();
  if (!s) return "【已保存的微信】这轮有一段微信聊天，还没有总结。不要编造里面说了什么。";
  return `【已保存的微信】下面是这段手机微信里已经说定的事，不是用户现在开口说的话。\n${s}`;
}

export function parseWechatReply(raw: string, stickerMax: number) {
  const t = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const i = t.indexOf("{");
  const j = t.lastIndexOf("}");
  let bubbles: string[] = [];
  let inner = "";
  let sticker = 0;
  if (i >= 0 && j > i) {
    try {
      const o = JSON.parse(t.slice(i, j + 1)) as { bubbles?: unknown; inner?: unknown; sticker?: unknown };
      if (Array.isArray(o.bubbles)) {
        bubbles = o.bubbles.map((x) => (typeof x === "string" ? x.trim() : "")).filter(Boolean);
      }
      inner = typeof o.inner === "string" ? o.inner.trim() : "";
      sticker = Number(o.sticker) || 0;
    } catch {
      bubbles = [];
    }
  }
  if (!bubbles.length) {
    const plain = t.replace(/\{[\s\S]*\}$/, "").trim();
    if (plain) bubbles = [plain];
  }
  bubbles = bubbles.slice(0, 3).map(clipBubble).filter(Boolean);
  if (!bubbles.some(hasWord)) bubbles = [];
  if (sticker < 1 || sticker > stickerMax) sticker = 0;
  return { bubbles, inner, sticker };
}

function clipBubble(s: string) {
  const t = s.replace(/\s+/g, " ").trim();
  const chars = [...t];
  if (chars.length <= 40) return t;
  return chars.slice(0, 40).join("").replace(/[，。！？、,.!?]$/, "");
}

function hasWord(s: string) {
  return /[\u4e00-\u9fffA-Za-z0-9]/.test(s);
}

function cleanSummary(s: string) {
  return s
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/[《》]/g, "")
    .replace(/[（）()]/g, "")
    .trim();
}

function sessionOf(chatId: string) {
  return useApp.getState().wechatSessions[chatId];
}

function patchSession(chatId: string, fn: (s: WechatSession) => WechatSession) {
  const cur = sessionOf(chatId);
  if (!cur) return;
  useApp.getState().setWechatSession(chatId, fn(cur));
}

function charOf(chat: Chat, charId: string) {
  return chat.characters.find((c) => c.id === charId) || chat.characters[0];
}

function storyBite(chat: Chat) {
  const mem = chat.memory.trim();
  const recent = chat.messages
    .slice(-6)
    .map((m) => {
      if (m.wechatLog) {
        return m.wechatLog.summary ? `微信里说定的：${m.wechatLog.summary}` : "有一段没总结的微信";
      }
      const who = m.role === "user" ? "用户" : m.characterName || "她";
      const text = (m.content || "").trim().slice(0, 280);
      return text ? `${who}：${text}` : "";
    })
    .filter(Boolean)
    .join("\n");
  return [mem ? `主聊天长期记忆：\n${mem.slice(0, 800)}` : "", recent ? `主聊天最近：\n${recent}` : ""]
    .filter(Boolean)
    .join("\n\n");
}

function lineText(line: WechatLine, withInner: boolean) {
  const who = line.role === "user" ? "用户" : "她";
  const bits: string[] = [];
  if (line.text.trim()) bits.push(`${who}：${line.text.trim()}`);
  const photos = line.attachments.filter((a) => a.kind === "photo").length;
  const sticks = line.attachments.filter((a) => a.kind === "sticker").length;
  if (photos) bits.push(photos > 1 ? `${who}发过 ${photos} 张照片` : `${who}发过一张照片`);
  if (sticks) bits.push(`${who}发过一张表情包`);
  if (line.gen?.status === "done") bits.push("她发过一张图");
  if (withInner && line.inner) bits.push(`她的内心（没发出去，不许写进气泡）：${line.inner}`);
  return bits.join("\n");
}

function transcript(session: WechatSession, withInner: boolean) {
  const recent = session.lines.map((line) => lineText(line, withInner)).filter(Boolean).join("\n");
  return [session.earlier.trim() ? `更早的微信：\n${session.earlier.trim()}` : "", recent ? `微信记录：\n${recent}` : ""]
    .filter(Boolean)
    .join("\n\n");
}

async function pushImage(parts: Part[], blobId: string, caption: string) {
  const url = await blobDataUrl(blobId);
  if (!url) return;
  parts.push({ type: "text", text: caption });
  parts.push({ type: "image_url", image_url: { url } });
}

async function replyMessages(chat: Chat, session: WechatSession, stickers: string[], turn: WechatLine) {
  const c = charOf(chat, session.charId);
  const name = c?.name.trim() || chat.name || "她";
  const head = [
    `你扮演${name}。`,
    c?.persona.trim() ? `人设：\n${c.persona.trim().slice(0, 1200)}` : "",
    c?.speech.trim() ? `说话方式：\n${c.speech.trim().slice(0, 600)}` : "",
    storyBite(chat),
    transcript(session, true),
    "这一轮用户刚发来的在下面。按微信回。",
    turn.text.trim() ? `用户的字：${turn.text.trim()}` : "用户这一轮没有写字。",
    userTurnCaption(turn.attachments, turn.text),
  ]
    .filter(Boolean)
    .join("\n\n");
  const parts: Part[] = [{ type: "text", text: head }];
  let photoN = 0;
  const photos = turn.attachments.filter((a) => a.kind === "photo");
  for (const photo of photos) {
    photoN += 1;
    const caption =
      photos.length > 1
        ? `下面这张是用户刚在微信里发来的第 ${photoN} 张照片，共 ${photos.length} 张。不是外貌备忘，也不是你眼前的实景。`
        : "下面这张是用户刚在微信里发来的照片，不是外貌备忘，也不是你眼前的实景。";
    await pushImage(parts, photo.blobId, caption);
  }
  for (const sticker of turn.attachments.filter((a) => a.kind === "sticker")) {
    await pushImage(parts, sticker.blobId, "下面这张是表情包，只取它的意思。");
  }
  const pack = stickers.slice(-8);
  if (pack.length) {
    parts.push({
      type: "text",
      text: "下面是你可以发的表情包，按编号。不合适就 sticker 填 0。不要把它们当成用户发来的。",
    });
    for (let i = 0; i < pack.length; i++) {
      await pushImage(parts, pack[i], `表情包 ${i + 1}`);
    }
  } else {
    parts.push({ type: "text", text: "这次没有可用的表情包。sticker 必须是 0。" });
  }
  return [{ role: "user" as const, content: parts }];
}

async function maybeFold(chatId: string) {
  const session = sessionOf(chatId);
  if (!session || session.lines.length <= 20) return;
  const keep = session.lines.slice(-16);
  const old = session.lines.slice(0, -16);
  const body = [session.earlier.trim(), ...old.map((line) => lineText(line, false))].filter(Boolean).join("\n");
  try {
    const text = await grokOnce({
      task: "wechat",
      extraSystem: FOLD_SYSTEM,
      messages: [{ role: "user", content: body }],
      max_tokens: 400,
    });
    const folded = cleanSummary(text);
    if (folded) patchSession(chatId, (s) => ({ ...s, earlier: folded, lines: keep }));
  } catch {
    /* 折不成就带着原文继续 */
  }
}

const busy = new Set<string>();

export async function sendWechat(chat: Chat, onTextReady: () => void) {
  const chatId = chat.id;
  if (busy.has(chatId)) return;
  const session = sessionOf(chatId);
  if (!session) return;
  const text = session.draft.trim();
  const pending = session.pending;
  if (!text && !pending.length) return;
  const armed = session.armed;
  const stickers = useApp.getState().wechatStickers;
  busy.add(chatId);
  const turn: WechatLine = {
    id: uid("w_"),
    role: "user",
    text,
    attachments: pending,
  };
  patchSession(chatId, (s) => ({ ...s, draft: "", pending: [], lines: [...s.lines, turn] }));
  try {
    await maybeFold(chatId);
    const live = sessionOf(chatId);
    if (!live) return;
    const raw = await grokOnce({
      task: "wechat",
      extraSystem: REPLY_SYSTEM,
      grokModelId: chat.grokModelId,
      messages: await replyMessages(chat, { ...live, lines: live.lines.filter((line) => line.id !== turn.id) }, stickers, turn),
      max_tokens: 800,
    });
    const parsed = parseWechatReply(raw, Math.min(8, stickers.length));
    if (!parsed.bubbles.length) throw new Error("没写成文字");
    const pack = stickers.slice(-8);
    const lines: WechatLine[] = parsed.bubbles.map((bubble) => ({
      id: uid("w_"),
      role: "assistant",
      text: bubble,
      attachments: [],
    }));
    if (parsed.sticker) {
      const blobId = pack[parsed.sticker - 1];
      if (blobId) {
        lines.push({
          id: uid("w_"),
          role: "assistant",
          text: "",
          attachments: [{ blobId, kind: "sticker" }],
        });
      }
    }
    if (armed) {
      lines.push({
        id: uid("w_"),
        role: "assistant",
        text: "",
        attachments: [],
        gen: { status: "pending" },
      });
    }
    lines[lines.length - 1] = { ...lines[lines.length - 1], inner: parsed.inner };
    patchSession(chatId, (s) => ({ ...s, lines: [...s.lines, ...lines] }));
    onTextReady();
    if (armed) {
      const genId = lines[lines.length - 1].id;
      await drawWechatImage(chat, chatId, genId, parsed.bubbles.join("\n"), text);
    }
  } catch (e) {
    onTextReady();
    const err = e instanceof Error ? e.message : "没发出去";
    if (err !== "Aborted") useApp.getState().toast(err);
  } finally {
    busy.delete(chatId);
  }
}

async function drawWechatImage(chat: Chat, chatId: string, genId: string, shot: string, turnUser: string) {
  const setGen = (gen: WechatLine["gen"]) => {
    patchSession(chatId, (s) => ({
      ...s,
      lines: s.lines.map((line) => (line.id === genId ? { ...line, gen } : line)),
    }));
  };
  const live = useApp.getState().chats.find((c) => c.id === chatId) ?? chat;
  try {
    const settings = useApp.getState().settings;
    if (!settings.naiKey) throw new Error("还没连接 NAI 中转站");
    const tags = await writeImageTags(live, shot, live.grokModelId, shot, "", undefined, turnUser);
    if (tags.presence) {
      const presence = tags.presence;
      useApp.getState().patchChat(chatId, (ch) => {
        const enabledOf = (slotId: string) =>
          presence.mode === "exact" ? presence.ids.includes(slotId) : !presence.ids.includes(slotId);
        return {
          ...ch,
          characters: ch.characters.map((role) => ({ ...role, imageEnabled: enabledOf(role.id) })),
          imageParams: {
            ...ch.imageParams,
            characters: ch.imageParams.characters.map((x) => ({ ...x, enabled: enabledOf(x.id) })),
          },
        };
      });
    }
    const fresh = useApp.getState().chats.find((c) => c.id === chatId) ?? live;
    const result = await generateNai({
      chat: fresh,
      grokTail: tags.base,
      charTails: tags.chars,
      apiKey: settings.naiKey,
      baseUrl: settings.naiBase,
      onStart: () => setGen({ status: "pending" }),
      onReceiving: () => useApp.getState().setCooldown(Date.now() + COOLDOWN_MS),
    });
    setGen({ status: "done", blobId: result.blobId });
  } catch (e) {
    const err = imageFailText(e);
    setGen({ status: "error", error: err });
    if (err !== "已取消") useApp.getState().toast(err);
  }
}

export async function summarizeWechat(chat: Chat, session: WechatSession) {
  const c = charOf(chat, session.charId);
  const name = c?.name.trim() || chat.name || "她";
  const raw = await grokOnce({
    task: "wechat",
    extraSystem: SUMMARY_SYSTEM,
    grokModelId: chat.grokModelId,
    messages: [
      {
        role: "user",
        content: `角色是${name}。\n\n${transcript(session, true) || "（没有内容）"}`,
      },
    ],
    max_tokens: 500,
  });
  const text = cleanSummary(raw);
  if (!text) throw new Error("总结是空的");
  return text;
}

export function userTurnCaption(attachments: WechatAttach[], text: string) {
  const photos = attachments.filter((a) => a.kind === "photo");
  const sticks = attachments.filter((a) => a.kind === "sticker");
  const bits: string[] = [];
  if (photos.length === 1) {
    bits.push(
      text.trim()
        ? "用户在微信里发来一张照片。上面的字是对着这张照片说的。这是他用手机发给你看的，不是你眼前的实景，不要把场景改成照片里的地方。按微信回他。"
        : "用户在微信里发来一张照片。这是他用手机发给你看的，不是你眼前的实景，不要把场景改成照片里的地方。按微信回他。",
    );
  } else if (photos.length > 1) {
    bits.push(
      text.trim()
        ? `用户在微信里发来 ${photos.length} 张照片，按编号。上面的字是对着这些照片说的。这是他用手机发给你看的，不是你眼前的实景，不要把场景改成照片里的地方。按微信回他。`
        : `用户在微信里发来 ${photos.length} 张照片，按编号。这是他用手机发给你看的，不是你眼前的实景，不要把场景改成照片里的地方。按微信回他。`,
    );
  }
  if (!text.trim() && photos.length) bits.push("他没有写字。看着照片回，不要当成没说话。");
  if (sticks.length) {
    bits.push("用户在微信里发来一张表情包。看它在表达什么，按这个意思回。不要把画里的人、地方或动作当成正在发生的事。");
  }
  return bits.join("\n");
}
