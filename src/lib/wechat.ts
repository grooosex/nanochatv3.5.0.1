import { COOLDOWN_MS } from "./constants.ts";
import { afterPaint, generateNai, imageFailText, makeImageRecord, parseImageTagOutput, writeImageTags } from "./engine.ts";
import { grokOnce } from "./grok-client.ts";
import { sanitizeNaiTags, type PresenceUpdate } from "./nai-tags.ts";
import { replyContextText } from "./reply-markup.ts";
import { blobDataUrl } from "./ref-image.ts";
import { resolveImageWrite } from "./image-ai.ts";
import { splitChatPrompt, wechatImageTail } from "./prompts.ts";
import { useApp } from "./store.ts";
import { wechatPresetStyle } from "./st-preset.ts";
import type { Chat, ChatMessage, Character, GenImage, ImageGenSource, WechatAttach, WechatLine, WechatRoom, WechatSession } from "./types.ts";
import { formatUserForChat, formatUserForImage, parseUserMarkup, standingDirectives } from "./user-markup.ts";
import { uid } from "./utils.ts";

type Part = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

const REPLY_SYSTEM = `你在和用户用手机微信聊天。你就是角色本人，坐在手机前面打字。你知道这是微信，不是面对面说话。

气泡里只写她发出去的话。不要写环境、动作、心理、旁白、摘要。
一次一到三条。至少一条里要有汉字，不能只有表情符号。每条通常一句，不超过 40 个字。一句够就一条，不要拆开凑数。作者指令如果指定她必须发出某一句，那一句可以超过 40 字。不要因此把整段写成小说。
Emoji 可以视情况写进文字里，不是每条都要。
表情包不是每次都要。没有发给你的表情包列表时，不要发，sticker 填 0。有列表时看情况选一张，不合适就填 0。

【已发生】必须在这一拍成立。身体和处境写进 inner，不要把整段事实塞进气泡，也不要念出括号。
【作者指令】她听不见，不准念。和这一拍有关的必须执行。画图、镜头、构图、tag 不要写进气泡。

inner 是此时此刻屏幕对面的她：动作、表情、心里话，大约四到八句。地点和正在做的事必须跟主聊天最近的情况，以及你这几条气泡。不许换地方，除非这几轮微信已经把人带到了那里。不要把剧情再往前演，不要把气泡重抄一遍。
如果这轮用户发来照片或表情包，inner 里用一两句写清画面大致是什么。这句只放 inner，不放进气泡。

只返回一个 JSON，不要 markdown，不要解释：
{"bubbles":["一条文字"],"inner":"内心","sticker":0}`;

const FOLD_SYSTEM = `把下面更早的微信压成一份简短记录，给后面的微信接着用。保留说定的事、人在哪、关系、现在停在哪。用户发过的照片或表情包，用一句话留下画面里是什么。她发过的图，留下提示词里的地点和动作。不要整段抄内心，不要写成小说。只输出正文。`;

const SUMMARY_SYSTEM = `你在给一段手机微信写总结，给主聊天的正文接着用。
你可以看内心，用来理解她当时的态度，但写出来的总结不要抄内心，不要写她没说出口的心理和只有你看得到的小动作。
只写微信上说定的事：定了什么、关系怎样、停在哪。提到她发过的照片时用一句话带过。
不要用书名号，不要用括号。只输出总结正文。`;

export function emptyWechatSession(charId: string): WechatSession {
  return { charId, lines: [], earlier: "", folded: 0, draft: "", pending: [], armed: false, minimized: false };
}

export const WECHAT_GROUP = "group";

export function wechatIsMulti(chat: Chat) {
  return chat.isMulti && chat.characters.length > 1;
}

function emptyRoom(): WechatRoom {
  return { lines: [], earlier: "", folded: 0, draft: "", pending: [] };
}

export function ensureMultiSession(chat: Chat, session: WechatSession): WechatSession {
  if (!wechatIsMulti(chat)) return session;
  const rooms: Record<string, WechatRoom> = {};
  for (const c of chat.characters) rooms[c.id] = session.rooms?.[c.id] ?? emptyRoom();
  rooms[WECHAT_GROUP] = session.rooms?.[WECHAT_GROUP] ?? emptyRoom();
  if (!session.rooms && session.lines.length) {
    const id = chat.characters.some((c) => c.id === session.charId) ? session.charId : chat.characters[0].id;
    rooms[id] = {
      lines: session.lines,
      earlier: session.earlier,
      folded: session.folded,
      draft: session.draft,
      pending: session.pending,
    };
  }
  const active =
    session.activeRoom && rooms[session.activeRoom]
      ? session.activeRoom
      : chat.characters.some((c) => c.id === session.charId)
        ? session.charId
        : chat.characters[0].id;
  return { ...session, rooms, activeRoom: active, lines: [], earlier: "", folded: 0, draft: "", pending: [] };
}

export function sessionHasLines(session: WechatSession) {
  if (session.rooms) return Object.values(session.rooms).some((room) => room.lines.length > 0);
  return session.lines.length > 0;
}

export function wechatTurnText(summary: string) {
  const s = summary.trim();
  if (!s) return "【已保存的微信】这轮有一段微信聊天，还没有总结。不要编造里面说了什么。";
  return `【已保存的微信】下面是这段手机微信里已经说定的事，不是用户现在开口说的话。\n${s}`;
}

export function parseWechatReply(raw: string, stickerMax: number, allowLong = false, strict = false) {
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
  if (!bubbles.length && !strict) {
    const plain = t.replace(/\{[\s\S]*\}$/, "").trim();
    if (plain && !plain.includes("<<<PROMPT>>>")) bubbles = [plain];
  }
  bubbles = bubbles.slice(0, 3).map((b) => clipBubble(b, allowLong)).filter(Boolean);
  if (!bubbles.some(hasWord)) bubbles = [];
  if (sticker < 1 || sticker > stickerMax) sticker = 0;
  return { bubbles, inner, sticker };
}

function clipBubble(s: string, allowLong = false) {
  const t = s.replace(/\s+/g, " ").trim();
  const max = allowLong ? 120 : 40;
  const chars = [...t];
  if (chars.length <= max) return t;
  return chars.slice(0, max).join("").replace(/[，。！？、,.!?]$/, "");
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

function personaPack(chat: Chat, charId: string) {
  const c = charOf(chat, charId);
  const extras = [...chat.extras, ...(c?.extras ?? [])].filter((e) => !e.emphasize && e.body.trim());
  return [
    chat.overview.trim() ? `【要求总览】\n${chat.overview.trim()}` : "",
    c?.name.trim() ? `你扮演${c.name.trim()}。` : "",
    c?.persona.trim() ? `人设：\n${c.persona.trim()}` : "",
    c?.speech.trim() ? `说话方式：\n${c.speech.trim()}` : "",
    c?.appearance.trim() ? `外貌备忘：\n${c.appearance.trim()}` : "",
    !chat.memory.trim() && chat.opening.trim() ? `【开场场景】\n${chat.opening.trim()}` : "",
    extras.length ? `【补丁】\n${extras.map((e) => e.body.trim()).join("\n")}` : "",
    chat.memory.trim() ? `【长期记忆】\n${chat.memory.trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function storyText(m: ChatMessage) {
  if (m.wechatLog?.voided) return "";
  if (m.wechatLog) return m.wechatLog.summary ? `微信里说定的：${m.wechatLog.summary}` : "有一段没总结的微信";
  const body = m.role === "user" ? (m.content || "").trim() : replyContextText(stripStatusBody(m.content || "")).trim();
  if (!body) return "";
  const who = m.role === "user" ? "用户" : m.characterName || "她";
  return `${who}：${body}`;
}

function stripStatusBody(text: string) {
  const i = text.lastIndexOf("状态栏:");
  return i < 0 ? text : text.slice(0, i);
}

function mainRecent(chat: Chat) {
  const msgs = chat.messages.filter((m) => !m.wechatLog?.voided && (m.role === "user" || m.content.trim()));
  const slice = msgs.slice(-12);
  if (!slice.length) return "";
  const lines = slice.map(storyText).filter(Boolean);
  if (!lines.length) return "";
  return `主聊天最近 6 轮，以最后一轮为重，前面只补还没被推翻的事：\n${lines.join("\n")}`;
}

function mainLatest(chat: Chat) {
  const msgs = chat.messages.filter((m) => !m.wechatLog);
  let assist = "";
  let user = "";
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!assist && m.role !== "user") assist = storyText(m);
    else if (assist && m.role === "user") {
      user = storyText(m);
      break;
    }
  }
  return [user, assist].filter(Boolean).join("\n");
}

export function wechatRounds(lines: WechatLine[]) {
  const rounds: WechatLine[][] = [];
  let cur: WechatLine[] = [];
  for (const line of lines) {
    if (line.role === "user" && cur.length) {
      rounds.push(cur);
      cur = [line];
    } else cur.push(line);
  }
  if (cur.length) rounds.push(cur);
  return rounds;
}

export function lineImages(line: WechatLine): GenImage[] {
  if (line.images?.length) return line.images;
  if (!line.gen) return [];
  const base = makeImageRecord({ id: `${line.id}-old`, seed: 1, createdAt: 0 });
  if (line.gen.status === "done" && line.gen.blobId) return [{ ...base, blobId: line.gen.blobId, status: "done" }];
  if (line.gen.status === "error") return [{ ...base, status: "error", error: line.gen.error || "没画成" }];
  return [{ ...base, status: "generating" }];
}

function herPrompt(line: WechatLine) {
  const done = lineImages(line).filter((g) => g.status === "done" && g.prompt.trim());
  return done.at(-1)?.prompt.trim() || "";
}

function lineText(line: WechatLine, withInner: boolean, names?: Record<string, string>) {
  const who = line.role === "user" ? "用户" : (line.speakerId && names?.[line.speakerId]) || "她";
  const bits: string[] = [];
  if (line.role === "user" && line.text.trim()) {
    const formatted = formatUserForChat(line.text, []);
    bits.push(formatted.startsWith("【") ? formatted : `用户：${line.text.trim()}`);
  } else if (line.text.trim()) bits.push(`${who}：${line.text.trim()}`);
  const photos = line.attachments.filter((a) => a.kind === "photo").length;
  const sticks = line.attachments.filter((a) => a.kind === "sticker").length;
  if (photos) bits.push(photos > 1 ? `${who}发过 ${photos} 张照片` : `${who}发过一张照片`);
  if (sticks) bits.push(`${who}发过一张表情包`);
  const prompt = herPrompt(line);
  if (prompt) bits.push(`她发过一张图，提示词：${prompt.slice(0, 500)}`);
  else if (line.gen?.status === "done" || lineImages(line).some((g) => g.status === "done")) bits.push("她发过一张图");
  if (withInner && line.inner) bits.push(`她的内心（没发出去，不许写进气泡）：${line.inner}`);
  return bits.join("\n");
}

function modelRounds(session: WechatSession) {
  const rounds = wechatRounds(session.lines);
  const folded = Math.min(session.folded || 0, rounds.length);
  return { rounds, pending: rounds.slice(folded), folded };
}

function transcript(session: WechatSession, withInner: boolean, names?: Record<string, string>) {
  const { pending } = modelRounds(session);
  const recent = pending
    .flat()
    .map((line) => lineText(line, withInner, names))
    .filter(Boolean)
    .join("\n");
  return [session.earlier.trim() ? `更早的微信摘要：\n${session.earlier.trim()}` : "", recent ? `微信记录，以最后一轮为重：\n${recent}` : ""]
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
  const standing = standingDirectives(chat);
  const head = [
    personaPack(chat, session.charId),
    mainRecent(chat),
    transcript(session, true),
    "这一轮用户刚发来的在下面。按微信回。",
    turn.text.trim() ? formatUserForChat(turn.text, standing) : "用户这一轮没有写字。",
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
  const older: WechatAttach[] = [];
  for (const round of modelRounds(session).pending) {
    for (const line of round) {
      if (line.id === turn.id) continue;
      older.push(...line.attachments);
    }
  }
  const keep = older.slice(-4);
  for (const item of keep) {
    await pushImage(
      parts,
      item.blobId,
      item.kind === "sticker"
        ? "下面这张是前面微信里发过的表情包，不是这一拍新发的。只取它的意思。"
        : "下面这张是前面微信里发过的照片，不是这一拍新发的，也不是你眼前的实景。",
    );
  }
  const pack = stickers.slice(-8);
  if (pack.length) {
    parts.push({
      type: "text",
      text: "下面是你可以发的表情包，按编号。不合适就 sticker 填 0。不要把它们当成用户发来的。",
    });
    for (let i = 0; i < pack.length; i++) await pushImage(parts, pack[i], `表情包 ${i + 1}`);
  } else {
    parts.push({ type: "text", text: "这次没有可用的表情包。sticker 必须是 0。" });
  }
  return [{ role: "user" as const, content: parts }];
}

async function maybeFold(chatId: string) {
  const session = sessionOf(chatId);
  if (!session) return;
  const rounds = wechatRounds(session.lines);
  const folded = Math.min(session.folded || 0, rounds.length);
  const pending = rounds.length - folded;
  if (pending <= 12) return;
  if (folded > 0 && pending < 20) return;
  const chunk = rounds.slice(folded, rounds.length - 12);
  const body = [session.earlier.trim(), ...chunk.flat().map((line) => lineText(line, true))].filter(Boolean).join("\n");
  if (!body.trim()) return;
  try {
    const text = await grokOnce({
      task: "wechat",
      extraSystem: FOLD_SYSTEM,
      grokModelId: useApp.getState().chats.find((c) => c.id === chatId)?.grokModelId,
      messages: [{ role: "user", content: body }],
      max_tokens: 500,
    });
    const next = cleanSummary(text);
    if (!next) return;
    patchSession(chatId, (s) => ({ ...s, earlier: next, folded: rounds.length - 12 }));
  } catch {
    /* 摘要失败就继续带着原文 */
  }
}

const busy = new Set<string>();
const imageStops = new Map<string, AbortController>();

function stopKey(chatId: string, lineId: string) {
  return `${chatId}:${lineId}`;
}

export function cancelWechatImage(chatId: string, lineId: string) {
  imageStops.get(stopKey(chatId, lineId))?.abort();
}

function clampFold(lines: WechatLine[], folded: number, earlier: string) {
  const n = wechatRounds(lines).length;
  if (folded > n) return { folded: 0, earlier: "" };
  return { folded, earlier };
}

async function completeReply(chat: Chat, turn: WechatLine, armed: boolean, onTextReady: () => void) {
  const chatId = chat.id;
  const stickers = useApp.getState().wechatStickers;
  await maybeFold(chatId);
  const live = sessionOf(chatId);
  if (!live) return;
  const settings = useApp.getState().settings;
  const inline = armed && !resolveImageWrite(settings.imageModelId).split;
  const prevScene = previousWechatPrompt(live, turn.id);
  const raw = await grokOnce({
    task: "wechat",
    extraSystem: [REPLY_SYSTEM, inline ? wechatImageTail(chat, prevScene) : ""].filter(Boolean).join("\n\n"),
    ...wechatPresetStyle(settings, chat, inline),
    grokModelId: chat.grokModelId,
    messages: await replyMessages(chat, { ...live, lines: live.lines.filter((line) => line.id !== turn.id) }, stickers, turn),
    max_tokens: inline ? 1800 : 800,
  });
  const allowLong = standingDirectives(chat).length > 0 || parseUserMarkup(turn.text).directives.length > 0;
  const split = splitChatPrompt(raw);
  const parsed = parseWechatReply(split.visible, Math.min(8, stickers.length), allowLong, Boolean(settings.stWechatActiveId));
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
    if (blobId) lines.push({ id: uid("w_"), role: "assistant", text: "", attachments: [{ blobId, kind: "sticker" }] });
  }
  if (armed) {
    const fresh = useApp.getState().chats.find((c) => c.id === chatId) ?? chat;
    lines.push({
      id: uid("w_"),
      role: "assistant",
      text: "",
      attachments: [],
      images: [
        makeImageRecord({
          model: fresh.imageParams.model,
          width: fresh.imageParams.width,
          height: fresh.imageParams.height,
          steps: fresh.imageParams.steps,
          sampler: fresh.imageParams.sampler,
          negative: fresh.imageParams.negative,
          ...(fresh.imageParams.seedLocked && fresh.imageParams.seed != null ? { seed: fresh.imageParams.seed } : {}),
          status: "writing",
          source: "auto",
        }),
      ],
    });
  }
  lines[lines.length - 1] = { ...lines[lines.length - 1], inner: parsed.inner };
  patchSession(chatId, (s) => ({ ...s, lines: [...s.lines, ...lines] }));
  onTextReady();
  if (armed) {
    const fresh = useApp.getState().chats.find((c) => c.id === chatId) ?? chat;
    const tags = inline && split.prompt ? parseImageTagOutput(split.prompt, fresh) : null;
    const hasTags = Boolean(tags && (tags.base || Object.keys(tags.chars).length));
    await paintWechat(chat, lines[lines.length - 1].id, "auto", undefined, undefined, hasTags ? tags! : undefined);
  }
}

const PRIVATE_EXTRA = `上面列出的群记录，你当时也在场，按已经发生过的事处理。不要把群记录照抄进气泡。
没有列出的其他角色私聊，你没看见。不准在气泡里提起，也不准写进内心。`;

const GROUP_SYSTEM = `你在微信群里。你要一次写出每个在场角色发出的消息。每个角色都是她本人，坐在自己手机前面打字。她们知道这是微信群。

气泡里只写发出去的话。不要写环境、动作、心理、旁白、摘要。
每人这一轮发 1 到 3 条文字。先发谁、谁连发、谁后发，按这一轮聊天自然决定。可以一个人连着说完再换人，也可以穿插。不要套固定的先后顺序。
每人至少一条里有汉字，不能只有表情符号。每条通常一句，不超过 40 个字。一句够就一条，不要拆开凑数。作者指令如果指定某一句必须发出，那一句可以超过 40 字。不要因此把整段写成小说。
Emoji 可以视情况写进文字里，不是每条都要。
表情包不是每次都要。没有表情包列表时，sticker 里每个角色都填 0。有列表时每人最多选一张，不合适就填 0。表情包不算进这 1 到 3 条。

【已发生】必须在这一拍成立。身体和处境写进这个角色自己的 inner，不要把整段事实塞进气泡，也不要念出括号。
【作者指令】她们听不见，不准念。和这一拍有关的必须执行。画图、镜头、构图、tag 不要写进气泡。

inner 按人分开。每个人的内心只写她自己这一拍的动作、表情和心里话，大约四到八句。地点和正在做的事必须跟主聊天最近的情况、群记录，以及她这几条气泡。不许换地方，除非这几轮已经把人带到了那里。不要把剧情再往前演，不要把气泡重抄一遍。
如果这轮用户发来照片或表情包，每个角色的 inner 里用一两句写清画面大致是什么。这句只放 inner，不放进气泡。

写某个角色的气泡和 inner 时，只能用群记录，以及标题写着「只有她知道」的那一块私聊。
其他角色的私聊块当不存在。不准写进她的气泡，也不准写进她的 inner。

只返回一个 JSON，不要 markdown，不要解释：
{"bubbles":[{"name":"角色名","text":"一条"}],"inner":{"角色名":"内心"},"sticker":{"角色名":0}}
name 必须是在场角色的名字。`;

function nameMap(chat: Chat) {
  return Object.fromEntries(chat.characters.map((c) => [c.id, c.name.trim() || "她"]));
}

function sideText(room: WechatRoom, names?: Record<string, string>) {
  const rounds = wechatRounds(room.lines);
  const folded = Math.min(room.folded || 0, rounds.length);
  const pending = rounds.slice(folded);
  if (!pending.length && !room.earlier.trim()) return "";
  const take = room.earlier.trim() ? Math.min(4, pending.length) : Math.min(8, pending.length);
  const recent = pending
    .slice(-take)
    .flat()
    .map((line) => lineText(line, true, names))
    .filter(Boolean)
    .join("\n");
  return [room.earlier.trim() ? `更早的摘要：\n${room.earlier.trim()}` : "", recent].filter(Boolean).join("\n\n");
}

function charCard(c: Character) {
  const extras = (c.extras ?? []).filter((e) => !e.emphasize && e.body.trim());
  return [
    `【${c.name.trim() || "她"}】`,
    c.persona.trim() ? `人设：\n${c.persona.trim()}` : "",
    c.speech.trim() ? `说话方式：\n${c.speech.trim()}` : "",
    c.appearance.trim() ? `外貌备忘：\n${c.appearance.trim()}` : "",
    extras.length ? `补丁：\n${extras.map((e) => e.body.trim()).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function parseGroupReply(raw: string, chat: Chat, stickerMax: number, allowLong: boolean) {
  const t = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const i = t.indexOf("{");
  const j = t.lastIndexOf("}");
  const byName = new Map(chat.characters.map((c) => [c.name.trim(), c]));
  const buckets = new Map<string, string[]>();
  const inners = new Map<string, string>();
  const stickers = new Map<string, number>();
  if (i >= 0 && j > i) {
    try {
      const o = JSON.parse(t.slice(i, j + 1)) as {
        bubbles?: unknown;
        inner?: unknown;
        sticker?: unknown;
      };
      if (Array.isArray(o.bubbles)) {
        for (const item of o.bubbles) {
          const rec = item as { name?: unknown; text?: unknown };
          const name = typeof rec?.name === "string" ? rec.name.trim() : "";
          const text = typeof rec?.text === "string" ? rec.text.trim() : "";
          const who = byName.get(name);
          if (!who || !text) continue;
          const list = buckets.get(who.id) ?? [];
          list.push(clipBubble(text, allowLong));
          buckets.set(who.id, list);
        }
      }
      if (o.inner && typeof o.inner === "object") {
        for (const [name, value] of Object.entries(o.inner as Record<string, unknown>)) {
          const who = byName.get(name.trim());
          if (who && typeof value === "string" && value.trim()) inners.set(who.id, value.trim());
        }
      }
      if (o.sticker && typeof o.sticker === "object") {
        for (const [name, value] of Object.entries(o.sticker as Record<string, unknown>)) {
          const who = byName.get(name.trim());
          const n = Number(value) || 0;
          if (who && n >= 1 && n <= stickerMax) stickers.set(who.id, n);
        }
      }
    } catch {
      buckets.clear();
    }
  }
  for (const [id, list] of buckets) {
    const clipped = list.filter(Boolean).slice(0, 3);
    if (!clipped.some(hasWord)) buckets.delete(id);
    else buckets.set(id, clipped);
  }
  return { buckets, inners, stickers };
}

async function foldRoom(chat: Chat, key: string) {
  const chatId = chat.id;
  const session = sessionOf(chatId);
  const room = session?.rooms?.[key];
  if (!session || !room) return;
  const rounds = wechatRounds(room.lines);
  const folded = Math.min(room.folded || 0, rounds.length);
  const pending = rounds.length - folded;
  if (pending <= 12) return;
  if (folded > 0 && pending < 20) return;
  const chunk = rounds.slice(folded, rounds.length - 12);
  const body = [room.earlier.trim(), ...chunk.flat().map((line) => lineText(line, true, nameMap(chat)))].filter(Boolean).join("\n");
  if (!body.trim()) return;
  try {
    const text = await grokOnce({
      task: "wechat",
      extraSystem: FOLD_SYSTEM,
      grokModelId: chat.grokModelId,
      messages: [{ role: "user", content: body }],
      max_tokens: 400,
    });
    const summary = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    if (!summary) return;
    patchSession(chatId, (s) => {
      const rooms = { ...(s.rooms ?? {}) };
      const cur = rooms[key];
      if (!cur) return s;
      rooms[key] = { ...cur, earlier: summary, folded: folded + chunk.length };
      return { ...s, rooms };
    });
  } catch {
    /* 折不了就留着原文 */
  }
}

async function multiMessages(chat: Chat, session: WechatSession, key: string, stickers: string[], turn: WechatLine) {
  const standing = standingDirectives(chat);
  const names = nameMap(chat);
  const rooms = session.rooms ?? {};
  const own = rooms[key] ?? emptyRoom();
  const ownView = { ...session, lines: own.lines.filter((line) => line.id !== turn.id), earlier: own.earlier, folded: own.folded, rooms: undefined };
  let head = "";
  if (key === WECHAT_GROUP) {
    const privates = chat.characters
      .map((c) => {
        const text = sideText(rooms[c.id] ?? emptyRoom());
        const name = c.name.trim() || "她";
        return text
          ? `【只有${name}知道的私聊】\n写${name}的气泡和 inner 时可以用。写其他角色时当这段不存在。\n${text}`
          : "";
      })
      .filter(Boolean)
      .join("\n\n");
    head = [
      chat.characters.map(charCard).join("\n\n"),
      chat.overview.trim() ? `【要求总览】\n${chat.overview.trim()}` : "",
      chat.memory.trim() ? `【长期记忆】\n${chat.memory.trim()}` : "",
      mainRecent(chat),
      transcript(ownView, true, names),
      privates,
      "这一轮用户刚发到群里的在下面。按微信回。",
      turn.text.trim() ? formatUserForChat(turn.text, standing) : "用户这一轮没有写字。",
      userTurnCaption(turn.attachments, turn.text),
    ]
      .filter(Boolean)
      .join("\n\n");
  } else {
    const groupText = sideText(rooms[WECHAT_GROUP] ?? emptyRoom(), names);
    head = [
      personaPack(chat, key),
      mainRecent(chat),
      groupText ? `【群记录】\n${groupText}` : "",
      transcript(ownView, true),
      "这一轮用户刚发来的在下面。按微信回。",
      turn.text.trim() ? formatUserForChat(turn.text, standing) : "用户这一轮没有写字。",
      userTurnCaption(turn.attachments, turn.text),
    ]
      .filter(Boolean)
      .join("\n\n");
  }
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
      text: "下面是可以发的表情包，按编号。不合适就填 0。不要把它们当成用户发来的。",
    });
    for (let i = 0; i < pack.length; i++) await pushImage(parts, pack[i], `表情包 ${i + 1}`);
  } else {
    parts.push({ type: "text", text: "这次没有可用的表情包。sticker 必须是 0。" });
  }
  return [{ role: "user" as const, content: parts }];
}

async function completeMulti(chat: Chat, key: string, turn: WechatLine, armed: boolean, onTextReady: () => void) {
  const chatId = chat.id;
  const stickers = useApp.getState().wechatStickers;
  await foldRoom(chat, key);
  const live = sessionOf(chatId);
  const room = live?.rooms?.[key];
  if (!live || !room) return;
  const settings = useApp.getState().settings;
  const inline = armed && !resolveImageWrite(settings.imageModelId).split;
  const group = key === WECHAT_GROUP;
  const prevScene = previousWechatPrompt({ ...live, lines: room.lines }, turn.id);
  const raw = await grokOnce({
    task: "wechat",
    extraSystem: [
      group ? GROUP_SYSTEM : `${REPLY_SYSTEM}\n\n${PRIVATE_EXTRA}`,
      inline ? wechatImageTail(chat, prevScene, group ? "all" : "solo") : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
    ...wechatPresetStyle(settings, chat, inline, group),
    grokModelId: chat.grokModelId,
    messages: await multiMessages(chat, { ...live, rooms: { ...live.rooms, [key]: room } }, key, stickers, turn),
    max_tokens: inline ? 2200 : group ? 1600 : 800,
  });
  const allowLong = standingDirectives(chat).length > 0 || parseUserMarkup(turn.text).directives.length > 0;
  const split = splitChatPrompt(raw);
  const pack = stickers.slice(-8);
  const lines: WechatLine[] = [];
  if (group) {
    const parsed = parseGroupReply(split.visible, chat, Math.min(8, stickers.length), allowLong);
    if (!parsed.buckets.size) throw new Error("没写成文字");
    for (const [id, bubbles] of parsed.buckets) {
      bubbles.forEach((bubble, index) => {
        lines.push({
          id: uid("w_"),
          role: "assistant",
          speakerId: id,
          text: bubble,
          attachments: [],
          inner: index === bubbles.length - 1 ? parsed.inners.get(id) : undefined,
        });
      });
      const sticker = parsed.stickers.get(id) || 0;
      const blobId = sticker ? pack[sticker - 1] : "";
      if (blobId) {
        const stickerLine: WechatLine = {
          id: uid("w_"),
          role: "assistant",
          speakerId: id,
          text: "",
          attachments: [{ blobId, kind: "sticker" }],
        };
        const owned = lines.filter((line) => line.speakerId === id);
        const last = owned[owned.length - 1];
        if (last?.inner) {
          stickerLine.inner = last.inner;
          last.inner = undefined;
        }
        lines.push(stickerLine);
      }
    }
  } else {
    const parsed = parseWechatReply(split.visible, Math.min(8, stickers.length), allowLong, Boolean(settings.stWechatActiveId));
    if (!parsed.bubbles.length) throw new Error("没写成文字");
    for (const bubble of parsed.bubbles) {
      lines.push({ id: uid("w_"), role: "assistant", speakerId: key, text: bubble, attachments: [] });
    }
    if (parsed.sticker) {
      const blobId = pack[parsed.sticker - 1];
      if (blobId) lines.push({ id: uid("w_"), role: "assistant", speakerId: key, text: "", attachments: [{ blobId, kind: "sticker" }] });
    }
    if (lines.length) lines[lines.length - 1] = { ...lines[lines.length - 1], inner: parsed.inner };
  }
  if (!lines.length) throw new Error("没写成文字");
  if (armed) {
    const fresh = useApp.getState().chats.find((c) => c.id === chatId) ?? chat;
    lines.push({
      id: uid("w_"),
      role: "assistant",
      text: "",
      attachments: [],
      images: [
        makeImageRecord({
          model: fresh.imageParams.model,
          width: fresh.imageParams.width,
          height: fresh.imageParams.height,
          steps: fresh.imageParams.steps,
          sampler: fresh.imageParams.sampler,
          negative: fresh.imageParams.negative,
          ...(fresh.imageParams.seedLocked && fresh.imageParams.seed != null ? { seed: fresh.imageParams.seed } : {}),
          status: "writing",
          source: "auto",
        }),
      ],
    });
  }
  patchSession(chatId, (s) => {
    const rooms = { ...(s.rooms ?? {}) };
    const cur = rooms[key] ?? emptyRoom();
    rooms[key] = { ...cur, lines: [...cur.lines, ...lines] };
    return { ...s, rooms };
  });
  onTextReady();
  if (armed) {
    const fresh = useApp.getState().chats.find((c) => c.id === chatId) ?? chat;
    const tags = inline && split.prompt ? parseImageTagOutput(split.prompt, group ? fresh : { ...fresh, isMulti: false }) : null;
    const hasTags = Boolean(tags && (tags.base || Object.keys(tags.chars).length));
    await paintWechat(chat, lines[lines.length - 1].id, "auto", undefined, undefined, hasTags ? tags! : undefined);
  }
}

async function withMultiRoom(chat: Chat) {
  const chatId = chat.id;
  let session = sessionOf(chatId);
  if (!session) return null;
  if (!session.rooms) {
    session = ensureMultiSession(chat, session);
    useApp.getState().setWechatSession(chatId, session);
  }
  const key = session.activeRoom && session.rooms?.[session.activeRoom] ? session.activeRoom : chat.characters[0]?.id;
  if (!key || !session.rooms?.[key]) return null;
  return { key, room: session.rooms[key] };
}

export async function sendWechat(chat: Chat, onTextReady: () => void, replaceFromId?: string) {
  if (wechatIsMulti(chat)) {
    const chatId = chat.id;
    if (busy.has(chatId)) return;
    const slot = await withMultiRoom(chat);
    if (!slot) return;
    const text = slot.room.draft.trim();
    const pending = slot.room.pending;
    if (!text && !pending.length) return;
    const armed = sessionOf(chatId)?.armed === true;
    let kept = slot.room.lines;
    if (replaceFromId) {
      const idx = slot.room.lines.findIndex((l) => l.id === replaceFromId);
      if (idx < 0) return;
      kept = slot.room.lines.slice(0, idx);
    }
    busy.add(chatId);
    const turn: WechatLine = { id: uid("w_"), role: "user", text, attachments: pending };
    const fold = clampFold(kept, slot.room.folded || 0, slot.room.earlier);
    patchSession(chatId, (s) => {
      const rooms = { ...(s.rooms ?? {}) };
      rooms[slot.key] = { ...slot.room, ...fold, draft: "", pending: [], lines: [...kept, turn] };
      return { ...s, rooms };
    });
    try {
      await completeMulti(chat, slot.key, turn, armed, onTextReady);
    } catch (e) {
      onTextReady();
      const err = e instanceof Error ? e.message : "没发出去";
      if (err !== "Aborted") useApp.getState().toast(err);
    } finally {
      busy.delete(chatId);
    }
    return;
  }
  const chatId = chat.id;
  if (busy.has(chatId)) return;
  const session = sessionOf(chatId);
  if (!session) return;
  const text = session.draft.trim();
  const pending = session.pending;
  if (!text && !pending.length) return;
  const armed = session.armed;
  let kept = session.lines;
  if (replaceFromId) {
    const idx = session.lines.findIndex((l) => l.id === replaceFromId);
    if (idx < 0) return;
    kept = session.lines.slice(0, idx);
  }
  busy.add(chatId);
  const turn: WechatLine = { id: uid("w_"), role: "user", text, attachments: pending };
  const fold = clampFold(kept, session.folded || 0, session.earlier);
  patchSession(chatId, (s) => ({ ...s, ...fold, draft: "", pending: [], lines: [...kept, turn] }));
  try {
    await completeReply(chat, turn, armed, onTextReady);
  } catch (e) {
    onTextReady();
    const err = e instanceof Error ? e.message : "没发出去";
    if (err !== "Aborted") useApp.getState().toast(err);
  } finally {
    busy.delete(chatId);
  }
}

export async function regenWechat(chat: Chat, lineId: string, onTextReady: () => void) {
  if (wechatIsMulti(chat)) {
    const chatId = chat.id;
    if (busy.has(chatId)) return;
    const slot = await withMultiRoom(chat);
    if (!slot) return;
    const idx = slot.room.lines.findIndex((l) => l.id === lineId);
    const turn = slot.room.lines[idx];
    if (!turn || turn.role !== "user") return;
    const kept = slot.room.lines.slice(0, idx + 1);
    const fold = clampFold(kept, slot.room.folded || 0, slot.room.earlier);
    busy.add(chatId);
    patchSession(chatId, (s) => {
      const rooms = { ...(s.rooms ?? {}) };
      rooms[slot.key] = { ...slot.room, ...fold, lines: kept };
      return { ...s, rooms };
    });
    try {
      await completeMulti(chat, slot.key, turn, sessionOf(chatId)?.armed === true, onTextReady);
    } catch (e) {
      onTextReady();
      const err = e instanceof Error ? e.message : "没发出去";
      if (err !== "Aborted") useApp.getState().toast(err);
    } finally {
      busy.delete(chatId);
    }
    return;
  }
  const chatId = chat.id;
  if (busy.has(chatId)) return;
  const session = sessionOf(chatId);
  if (!session) return;
  const idx = session.lines.findIndex((l) => l.id === lineId);
  const turn = session.lines[idx];
  if (!turn || turn.role !== "user") return;
  const kept = session.lines.slice(0, idx + 1);
  const fold = clampFold(kept, session.folded || 0, session.earlier);
  busy.add(chatId);
  patchSession(chatId, (s) => ({ ...s, ...fold, lines: kept }));
  try {
    await completeReply(chat, turn, session.armed, onTextReady);
  } catch (e) {
    onTextReady();
    const err = e instanceof Error ? e.message : "没发出去";
    if (err !== "Aborted") useApp.getState().toast(err);
  } finally {
    busy.delete(chatId);
  }
}

function patchLine(chatId: string, lineId: string, fn: (line: WechatLine) => WechatLine) {
  patchSession(chatId, (s) => {
    if (s.rooms) {
      const rooms = { ...s.rooms };
      for (const [key, room] of Object.entries(rooms)) {
        if (!room.lines.some((line) => line.id === lineId)) continue;
        rooms[key] = { ...room, lines: room.lines.map((line) => (line.id === lineId ? fn(line) : line)) };
        return { ...s, rooms };
      }
    }
    return { ...s, lines: s.lines.map((line) => (line.id === lineId ? fn(line) : line)) };
  });
}

function linesHolding(session: WechatSession, lineId: string) {
  if (session.rooms) {
    for (const room of Object.values(session.rooms)) {
      if (room.lines.some((line) => line.id === lineId)) return room.lines;
    }
  }
  return session.lines;
}

function roomKeyOf(session: WechatSession, lineId: string) {
  if (!session.rooms) return "";
  for (const [key, room] of Object.entries(session.rooms)) {
    if (room.lines.some((line) => line.id === lineId)) return key;
  }
  return "";
}

function previousWechatPrompt(session: WechatSession, lineId: string) {
  const lines = linesHolding(session, lineId);
  const idx = lines.findIndex((l) => l.id === lineId);
  for (let i = idx - 1; i >= 0; i--) {
    const prompt = herPrompt(lines[i]);
    if (prompt) return prompt.slice(0, 400);
  }
  return "";
}

export async function paintWechat(
  chat: Chat,
  lineId: string,
  mode: ImageGenSource,
  custom?: string,
  customChars?: Record<string, string>,
  parsedTags?: { base: string; chars: Record<string, string>; presence?: PresenceUpdate },
) {
  const chatId = chat.id;
  const session = sessionOf(chatId);
  if (!session) return;
  const line = linesHolding(session, lineId).find((l) => l.id === lineId);
  if (!line) return;
  const imgs = lineImages(line);
  if (imgs.some((g) => g.status !== "done" && g.status !== "error" && g.status !== "writing")) return;
  const prev = [...imgs].reverse().find((g) => g.prompt.trim());
  const writing = imgs.find((g) => g.status === "writing");
  const needsWrite = !parsedTags && mode !== "custom" && !(mode === "same" && prev?.prompt);
  const freshChat = useApp.getState().chats.find((c) => c.id === chatId) ?? chat;
  const record =
    writing && (mode === "auto" || mode === "rewrite")
      ? { ...writing, status: "writing" as const, source: mode }
      : makeImageRecord({
          model: freshChat.imageParams.model,
          width: freshChat.imageParams.width,
          height: freshChat.imageParams.height,
          steps: freshChat.imageParams.steps,
          sampler: freshChat.imageParams.sampler,
          negative: freshChat.imageParams.negative,
          ...(freshChat.imageParams.seedLocked && freshChat.imageParams.seed != null ? { seed: freshChat.imageParams.seed } : {}),
          status: needsWrite ? "writing" : "uploading",
          source: mode,
        });
  patchLine(chatId, lineId, (cur) => {
    const list = lineImages(cur).filter((g) => g.id !== `${cur.id}-old`);
    const next = list.some((g) => g.id === record.id) ? list.map((g) => (g.id === record.id ? record : g)) : [...list, record];
    return { ...cur, gen: undefined, images: next };
  });
  const setImg = (p: Partial<GenImage>) => patchLine(chatId, lineId, (cur) => ({ ...cur, images: lineImages(cur).map((g) => (g.id === record.id ? { ...g, ...p } : g)) }));
  const ac = new AbortController();
  const key = stopKey(chatId, lineId);
  imageStops.get(key)?.abort();
  imageStops.set(key, ac);
  try {
    const settings = useApp.getState().settings;
    if (!settings.naiKey) throw new Error("还没连接 NAI 中转站");
    let grokTail = custom ? sanitizeNaiTags(custom, { stripForbidden: false }) : "";
    let charTails: Record<string, string> = {};
    if (customChars) {
      for (const [k, v] of Object.entries(customChars)) {
        const t = sanitizeNaiTags(v, { stripForbidden: false });
        if (t) charTails[k] = t;
      }
    }
    if (parsedTags && mode === "auto") {
      grokTail = parsedTags.base;
      charTails = { ...parsedTags.chars };
      if (parsedTags.presence && !wechatIsMulti(freshChat)) {
        const presence = parsedTags.presence;
        useApp.getState().patchChat(chatId, (ch) => {
          const enabledOf = (slotId: string) => (presence.mode === "exact" ? presence.ids.includes(slotId) : !presence.ids.includes(slotId));
          return {
            ...ch,
            characters: ch.characters.map((role) => ({ ...role, imageEnabled: enabledOf(role.id) })),
            imageParams: { ...ch.imageParams, characters: ch.imageParams.characters.map((x) => ({ ...x, enabled: enabledOf(x.id) })) },
          };
        });
      }
    } else if (mode === "same" && prev?.prompt) {
      grokTail = prev.prompt;
      charTails = { ...(prev.charTails || {}) };
    } else if (mode !== "custom") {
      const now = sessionOf(chatId) ?? session;
      const live = useApp.getState().chats.find((c) => c.id === chatId) ?? freshChat;
      const held = linesHolding(now, lineId);
      const round = wechatRounds(held).find((r) => r.some((l) => l.id === lineId)) ?? [];
      const group = roomKeyOf(now, lineId) === WECHAT_GROUP;
      const nameOf = (id?: string) => live.characters.find((c) => c.id === id)?.name.trim() || "她";
      const bubbles = group
        ? round
            .filter((l) => l.role === "assistant" && l.text.trim())
            .map((l) => `${nameOf(l.speakerId)}：${l.text.trim()}`)
            .join("\n")
        : round
            .filter((l) => l.role === "assistant" && l.text.trim())
            .map((l) => l.text.trim())
            .join("\n");
      const inner = group
        ? round
            .filter((l) => l.inner?.trim())
            .map((l) => `${nameOf(l.speakerId)}的内心：\n${l.inner?.trim()}`)
            .join("\n\n")
        : [...round].reverse().find((l) => l.inner)?.inner?.trim() || "";
      const user = round.find((l) => l.role === "user");
      const shot = [
        inner ? (group ? `这一轮各人的地点、动作、表情（以这段为重）：\n${inner}` : `这一拍她实际的地点、动作、表情（以这段为重）：\n${inner}`) : "",
        bubbles ? (group ? `这一轮群里刚发出的微信：\n${bubbles}` : `她刚发出的微信：\n${bubbles}`) : "",
        mainLatest(live) ? `主聊天最近一轮，只补背景：\n${mainLatest(live)}` : "",
        user ? formatUserForImage(user.text, standingDirectives(live)) : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      const cast = group ? "all" : wechatIsMulti(live) ? "solo" : undefined;
      const tags = await writeImageTags(live, "", live.grokModelId, shot, previousWechatPrompt(now, lineId), ac.signal, user?.text || "", cast);
      grokTail = tags.base;
      charTails = tags.chars;
      if (tags.presence && !wechatIsMulti(live)) {
        const presence = tags.presence;
        useApp.getState().patchChat(chatId, (ch) => {
          const enabledOf = (slotId: string) => (presence.mode === "exact" ? presence.ids.includes(slotId) : !presence.ids.includes(slotId));
          return {
            ...ch,
            characters: ch.characters.map((role) => ({ ...role, imageEnabled: enabledOf(role.id) })),
            imageParams: { ...ch.imageParams, characters: ch.imageParams.characters.map((x) => ({ ...x, enabled: enabledOf(x.id) })) },
          };
        });
      }
    }
    if (!grokTail && !Object.keys(charTails).length) {
      setImg({ status: "error", error: "提示词写失败" });
      return;
    }
    setImg({ status: "uploading", prompt: grokTail, charTails });
    await afterPaint();
    const live = useApp.getState().chats.find((c) => c.id === chatId) ?? freshChat;
    const roomKey = roomKeyOf(sessionOf(chatId) ?? session, lineId);
    const genChat = wechatIsMulti(live)
      ? {
          ...live,
          imageParams: {
            ...live.imageParams,
            characters: live.imageParams.characters.map((slot) => ({
              ...slot,
              enabled: roomKey === WECHAT_GROUP ? true : roomKey ? slot.id === roomKey : slot.enabled,
            })),
          },
        }
      : live;
    const result = await generateNai({
      chat: genChat,
      grokTail,
      charTails,
      seed: record.seed,
      apiKey: settings.naiKey,
      baseUrl: settings.naiBase,
      signal: ac.signal,
      onStart: () => setImg({ status: "generating" }),
      onReceiving: () => {
        useApp.getState().setCooldown(Date.now() + COOLDOWN_MS);
        setImg({ status: "receiving" });
      },
    });
    setImg({ status: "done", blobId: result.blobId, prompt: grokTail, charTails, seed: result.seed });
  } catch (e) {
    const err = imageFailText(e, ac.signal);
    setImg({ status: "error", error: err });
    if (err !== "已取消") useApp.getState().toast(err);
  } finally {
    if (imageStops.get(key) === ac) imageStops.delete(key);
  }
}


export async function summarizeWechat(chat: Chat, session: WechatSession) {
  if (wechatIsMulti(chat) && session.rooms) {
    const names = nameMap(chat);
    const blocks = [
      ...chat.characters.map((c) => {
        const text = sideText(session.rooms?.[c.id] ?? emptyRoom(), names);
        return text ? `和${c.name.trim() || "她"}的私聊：\n${text}` : "";
      }),
      sideText(session.rooms[WECHAT_GROUP] ?? emptyRoom(), names)
        ? `群聊：\n${sideText(session.rooms[WECHAT_GROUP] ?? emptyRoom(), names)}`
        : "",
    ].filter(Boolean);
    const raw = await grokOnce({
      task: "wechat",
      extraSystem: SUMMARY_SYSTEM,
      grokModelId: chat.grokModelId,
      messages: [{ role: "user", content: blocks.join("\n\n") || "（没有内容）" }],
      max_tokens: 700,
    });
    const text = cleanSummary(raw);
    if (!text) throw new Error("总结是空的");
    return text;
  }
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

export function detachWechat(chatId: string): ChatMessage | null {
  const session = useApp.getState().wechatSessions[chatId];
  if (!session) return null;
  const lines = session.rooms ? Object.values(session.rooms).flatMap((room) => room.lines) : session.lines;
  for (const line of lines) cancelWechatImage(chatId, line.id);
  useApp.getState().setWechatSession(chatId, null);
  if (!lines.length) return null;
  const chat = useApp.getState().chats.find((c) => c.id === chatId);
  const role = chat?.characters.find((c) => c.id === session.charId) || chat?.characters[0];
  const roomNames = chat
    ? Object.fromEntries([...chat.characters.map((c) => [c.id, c.name.trim() || "角色"]), [WECHAT_GROUP, "群聊"]])
    : undefined;
  return {
    id: uid("m_"),
    role: "user",
    content: "",
    images: [],
    createdAt: Date.now(),
    wechatLog: {
      charName: session.rooms ? "微信" : role?.name.trim() || chat?.name || "她",
      lines: session.rooms ? [] : session.lines,
      summary: "",
      voided: true,
      ...(session.rooms
        ? { rooms: session.rooms, activeRoom: session.activeRoom, roomNames }
        : {}),
    },
  };
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
