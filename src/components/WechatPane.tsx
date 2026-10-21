import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ArrowUp, Check, ChevronLeft, Download, Loader2, Maximize2, Minus, Minimize2, Pencil, Plus, RefreshCw, Smile, Sparkles, Wand2, X } from "lucide-react";
import { getImage, imageUrl } from "@/lib/idb";
import { genPhaseLabel } from "@/lib/image-status";
import { modelLabel, samplerLabel } from "@/lib/nai";
import { extractGrokTail } from "@/lib/nai-tags";
import { compressRef, isImageFile } from "@/lib/ref-image";
import { saveBlob, useApp } from "@/lib/store";
import type { Chat, GenImage, WechatAttach, WechatLine, WechatLog, WechatSession } from "@/lib/types";
import { emptyWechatSession, ensureMultiSession, lineImages, paintWechat, regenWechat, sendWechat, sessionHasLines, summarizeWechat, WECHAT_GROUP, wechatIsMulti, wechatTurnText, cancelWechatImage } from "@/lib/wechat";
import { downloadBlob, uid } from "@/lib/utils";
import { ImagePick } from "./ImagePick";
import { ChatAvatar, useCooldown } from "./ui-kit";

const EMOJI = [
  "😀", "😁", "😂", "🤣", "😊", "😍", "😘", "😜",
  "🤔", "😅", "😭", "😡", "🥺", "😏", "😴", "🤗",
  "👍", "👎", "👏", "🙏", "👌", "✌️", "🤝", "💪",
  "❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "💔",
  "🎉", "✨", "🔥", "⭐", "🌙", "☀️", "🌈", "⚡",
];

export function WechatDock({ chat }: { chat: Chat }) {
  const session = useApp((s) => s.wechatSessions[chat.id] ?? null);
  const view = useApp((s) => (s.ui.wechatView?.chatId === chat.id ? s.ui.wechatView : null));
  if (view) {
    const msg = chat.messages.find((m) => m.id === view.msgId);
    if (msg?.wechatLog) {
      return (
        <WechatRead
          chat={chat}
          log={msg.wechatLog}
          onClose={() => useApp.getState().setUI({ wechatView: null })}
        />
      );
    }
  }
  if (session && !session.minimized) return <WechatLive chat={chat} session={session} />;
  return null;
}

export function openWechat(chat: Chat) {
  const cur = useApp.getState().wechatSessions[chat.id];
  useApp.getState().setUI({ wechatView: null });
  if (cur) {
    const next = wechatIsMulti(chat) ? ensureMultiSession(chat, { ...cur, minimized: false }) : { ...cur, minimized: false };
    useApp.getState().setWechatSession(chat.id, next);
    return;
  }
  const fresh = emptyWechatSession(chat.characters[0]?.id || "");
  useApp.getState().setWechatSession(chat.id, wechatIsMulti(chat) ? ensureMultiSession(chat, fresh) : fresh);
}

function WechatLive({ chat, session }: { chat: Chat; session: WechatSession }) {
  const stickers = useApp((s) => s.wechatStickers);
  const cooldownUntil = useApp((s) => s.settings.cooldownUntil);
  const left = useCooldown(cooldownUntil);
  const portrait = chat.imageParams.height >= chat.imageParams.width;
  const [emoji, setEmoji] = useState(false);
  const [tab, setTab] = useState<"emoji" | "heart">("emoji");
  const [phase, setPhase] = useState<"idle" | "type" | "sum">("idle");
  const [ask, setAsk] = useState<null | "close" | "fail">(null);
  const [openInner, setOpenInner] = useState<Record<string, boolean>>({});
  const scroller = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const char = chat.characters.find((c) => c.id === session.charId) || chat.characters[0];
  const multi = wechatIsMulti(chat);
  const active = multi ? session.activeRoom || chat.characters[0]?.id || WECHAT_GROUP : "";
  const room = multi ? session.rooms?.[active] : undefined;
  const lines = room ? room.lines : session.lines;
  const draft = room ? room.draft : session.draft;
  const pending = room ? room.pending : session.pending;
  const activeChar = multi && active !== WECHAT_GROUP ? chat.characters.find((c) => c.id === active) : char;
  const name = multi ? (active === WECHAT_GROUP ? "群聊" : activeChar?.name.trim() || "她") : char?.name.trim() || chat.name || "她";
  const [full, setFull] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [editFrom, setEditFrom] = useState<string | null>(null);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [lines.length, phase, pending.length]);

  const patch = (p: Partial<WechatSession>) => {
    const cur = useApp.getState().wechatSessions[chat.id];
    if (!cur) return;
    useApp.getState().setWechatSession(chat.id, { ...cur, ...p });
  };

  const patchView = (p: { draft?: string; pending?: WechatAttach[] }) => {
    if (!multi) {
      patch(p);
      return;
    }
    const cur = useApp.getState().wechatSessions[chat.id];
    if (!cur?.rooms || !active) return;
    const rooms = { ...cur.rooms, [active]: { ...cur.rooms[active], ...p } };
    useApp.getState().setWechatSession(chat.id, { ...cur, rooms });
  };

  const addPending = (items: WechatAttach[]) => {
    const roomLeft = 9 - pending.length;
    if (roomLeft <= 0) {
      useApp.getState().toast("最多 9 张");
      return;
    }
    if (items.length > roomLeft) useApp.getState().toast("最多 9 张");
    patchView({ pending: [...pending, ...items.slice(0, roomLeft)] });
  };

  const send = () => {
    if (phase !== "idle") return;
    if (!draft.trim() && !pending.length) return;
    setPhase("type");
    setEmoji(false);
    const from = editFrom;
    setEditFrom(null);
    setPicked(null);
    void sendWechat(chat, () => setPhase("idle"), from ?? undefined);
  };

  const close = () => {
    const cur = useApp.getState().wechatSessions[chat.id];
    if (!cur || !sessionHasLines(cur)) {
      useApp.getState().setWechatSession(chat.id, null);
      return;
    }
    setAsk("close");
  };

  const discard = () => {
    setAsk(null);
    useApp.getState().setWechatSession(chat.id, null);
  };

  const commit = (summary: string) => {
    const cur = useApp.getState().wechatSessions[chat.id];
    if (!cur) return;
    const log: WechatLog = cur.rooms
      ? {
          charName: "微信",
          lines: [],
          summary,
          rooms: cur.rooms,
          activeRoom: cur.activeRoom,
          roomNames: Object.fromEntries([
            ...chat.characters.map((c) => [c.id, c.name.trim() || "角色"]),
            [WECHAT_GROUP, "群聊"],
          ]),
        }
      : {
          charName: name,
          lines: cur.lines,
          summary,
        };
    useApp.getState().patchChat(chat.id, (ch) => ({
      ...ch,
      messages: [
        ...ch.messages,
        {
          id: uid("m_"),
          role: "user" as const,
          content: wechatTurnText(summary),
          images: [],
          createdAt: Date.now(),
          wechatLog: log,
        },
      ],
    }));
    useApp.getState().setWechatSession(chat.id, null);
    setAsk(null);
    setPhase("idle");
  };

  const save = async () => {
    const cur = useApp.getState().wechatSessions[chat.id];
    if (!cur) return;
    setAsk(null);
    setPhase("sum");
    try {
      const summary = await summarizeWechat(chat, cur);
      commit(summary);
    } catch (e) {
      setPhase("idle");
      setAsk("fail");
      useApp.getState().toast(e instanceof Error ? e.message : "总结失败");
    }
  };

  return (
    <Shell
      title={phase === "type" ? "正在输入中..." : name}
      onClose={close}
      full={full}
      onFull={() => setFull((v) => !v)}
      onMinimize={() => {
        setFull(false);
        patch({ minimized: true });
      }}
      scrollRef={scroller}
      overlay={
        ask ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/30 px-8">
            <div className="relative w-full rounded-2xl bg-white p-4 text-black">
              {ask === "close" ? (
                <button type="button" className="absolute right-3 top-3" aria-label="取消" onClick={() => setAsk(null)}>
                  <X className="size-5" />
                </button>
              ) : null}
              <div className="mb-4 pr-6 text-[15px]">{ask === "close" ? "是否保存当前微信内容到聊天" : "总结没写成"}</div>
              <div className="flex gap-2">
                {ask === "close" ? (
                  <>
                    <button type="button" className="flex-1 rounded-lg border border-neutral-300 py-2" onClick={discard}>
                      不保存
                    </button>
                    <button type="button" className="flex-1 rounded-lg bg-[#95EC69] py-2" onClick={() => void save()}>
                      保存
                    </button>
                  </>
                ) : (
                  <>
                    <button type="button" className="flex-1 rounded-lg border border-neutral-300 py-2 text-[13px]" onClick={() => commit("")}>
                      仅保存微信聊天
                    </button>
                    <button type="button" className="flex-1 rounded-lg bg-[#95EC69] py-2" onClick={() => void save()}>
                      重试
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        ) : null
      }
      footer={
        <>
          {pending.length ? (
            <div className="mb-2 flex gap-2 overflow-x-auto">
              {pending.map((item, i) => (
                <PendingThumb
                  key={`${item.blobId}-${i}`}
                  blobId={item.blobId}
                  mark={item.kind === "sticker" ? "表情" : ""}
                  onRemove={() => patchView({ pending: pending.filter((_, at) => at !== i) })}
                />
              ))}
            </div>
          ) : null}
          <div className="mb-2 flex items-center gap-1.5 text-[13px] text-black">
            <div className="inline-flex h-[22px] items-center gap-1.5 rounded-md border border-neutral-300 bg-white px-1.5">
              <button
                type="button"
                className={portrait ? "font-medium text-black" : "text-neutral-400"}
                onClick={() => {
                  if (!portrait) {
                    useApp.getState().patchParams(chat.id, {
                      width: chat.imageParams.height,
                      height: chat.imageParams.width,
                    });
                  }
                }}
              >
                竖图
              </button>
              <span className="text-neutral-300">|</span>
              <button
                type="button"
                className={!portrait ? "font-medium text-black" : "text-neutral-400"}
                onClick={() => {
                  if (portrait) {
                    useApp.getState().patchParams(chat.id, {
                      width: chat.imageParams.height,
                      height: chat.imageParams.width,
                    });
                  }
                }}
              >
                横图
              </button>
            </div>
            <button
              type="button"
              className={`mx-auto inline-flex h-[22px] items-center rounded-md border px-2 ${session.armed ? "border-red-500 text-red-500" : "border-neutral-300 text-neutral-500"}`}
              onClick={() => patch({ armed: !session.armed })}
            >
              {left > 0 ? `${left}s` : "可生图"}
            </button>
            <button
              type="button"
              className={`inline-flex h-[22px] items-center rounded-md border border-neutral-300 px-1.5 ${chat.adultBoost ? "font-medium text-black" : "text-neutral-400"}`}
              onClick={() => useApp.getState().patchChat(chat.id, { adultBoost: !chat.adultBoost })}
            >
              成人提示词
            </button>
          </div>
          {multi ? (
            <div className="mb-2 flex gap-1.5 overflow-x-auto">
              {chat.characters.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={`shrink-0 rounded-full border px-2 py-0.5 text-[12px] ${c.id === active ? "border-red-500 text-red-500" : "border-neutral-300 text-neutral-500"}`}
                  onClick={() => patch({ activeRoom: c.id })}
                >
                  {c.name.trim() || "角色"}
                </button>
              ))}
              <button
                type="button"
                className={`shrink-0 rounded-full border px-2 py-0.5 text-[12px] ${active === WECHAT_GROUP ? "border-red-500 text-red-500" : "border-neutral-300 text-neutral-500"}`}
                onClick={() => patch({ activeRoom: WECHAT_GROUP })}
              >
                群聊
              </button>
            </div>
          ) : null}
          <div className="flex items-end gap-1.5">
            {emoji ? (
              <button type="button" className="grid size-9 shrink-0 place-items-center text-neutral-500" onClick={() => setEmoji(false)} aria-label="收起表情">
                <ChevronLeft className="size-5" />
              </button>
            ) : null}
            <textarea
              ref={inputRef}
              value={draft}
              rows={1}
              className="max-h-24 min-h-9 flex-1 resize-none rounded-md bg-white px-3 py-2 text-[15px] text-black outline-none"
              onChange={(e) => patchView({ draft: e.target.value })}
            />
            <button
              type="button"
              className={`grid size-9 shrink-0 place-items-center ${emoji ? "text-red-500" : "text-neutral-600"}`}
              aria-label="表情"
              onClick={() => setEmoji((v) => !v)}
            >
              <Smile className="size-6" />
            </button>
            <ImagePick
              multiple
              onFile={() => undefined}
              onFiles={(files) => void addFiles(files, addPending)}
              onBlobs={(ids) => void addBlobs(ids, "photo", addPending)}
              render={(open) => (
                <button type="button" className="grid size-9 shrink-0 place-items-center text-neutral-600" aria-label="添加" onClick={open}>
                  <Plus className="size-6" />
                </button>
              )}
            />
            <button
              type="button"
              className="grid size-9 shrink-0 place-items-center rounded-md bg-[#95EC69] text-black disabled:opacity-40"
              aria-label="发送"
              disabled={phase !== "idle" || (!draft.trim() && !pending.length)}
              onClick={send}
            >
              <ArrowUp className="size-5" />
            </button>
          </div>
          {emoji ? (
            <EmojiPanel
              tab={tab}
              setTab={setTab}
              stickers={stickers}
              onEmoji={(ch) => {
                patch({ draft: session.draft + ch });
                inputRef.current?.focus();
              }}
              onSticker={(blobId) => addPending([{ blobId, kind: "sticker" }])}
              onDeleteSticker={(blobId) => {
                useApp.getState().setWechatStickers(stickers.filter((id) => id !== blobId));
              }}
              onAddSticker={(blobId) => useApp.getState().setWechatStickers([...stickers, blobId])}
            />
          ) : null}
        </>
      }
    >
      <Thread
        chat={chat}
        name={name}
        lines={lines}
        names={multi && active === WECHAT_GROUP}
        openInner={openInner}
        toggleInner={(id) => setOpenInner((m) => ({ ...m, [id]: !m[id] }))}
        picked={picked}
        onPick={(id) => setPicked((cur) => (cur === id ? null : id))}
        onRegen={(id) => {
          setPicked(null);
          setPhase("type");
          void regenWechat(chat, id, () => setPhase("idle"));
        }}
        onEdit={(line) => {
          patch({ draft: line.text, pending: line.attachments });
          setEditFrom(line.id);
          setPicked(null);
        }}
      />
      {phase === "sum" ? <div className="py-2 text-center text-[12px] text-neutral-500">正在总结</div> : null}
    </Shell>
  );
}

function WechatRead({ chat, log, onClose }: { chat: Chat; log: WechatLog; onClose: () => void }) {
  const [openInner, setOpenInner] = useState<Record<string, boolean>>({});
  const [full, setFull] = useState(false);
  return (
    <Shell title={log.charName || "微信"} onClose={onClose} full={full} onFull={() => setFull((v) => !v)}>
      <Thread
        chat={chat}
        name={log.charName}
        lines={log.lines}
        openInner={openInner}
        toggleInner={(id) => setOpenInner((m) => ({ ...m, [id]: !m[id] }))}
        readOnly
      />
      {log.summary.trim() ? (
        <div className="mt-4 rounded-lg bg-white px-3 py-2 text-[13px] leading-relaxed text-black">
          <div className="mb-1 text-[12px] text-neutral-400">总结</div>
          {log.summary}
        </div>
      ) : (
        <div className="mt-4 text-center text-[12px] text-neutral-400">这段还没有总结</div>
      )}
    </Shell>
  );
}

function Shell({
  title,
  onClose,
  children,
  footer,
  overlay,
  scrollRef,
  full,
  onFull,
  onMinimize,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  overlay?: ReactNode;
  scrollRef?: RefObject<HTMLDivElement | null>;
  full?: boolean;
  onFull?: () => void;
  onMinimize?: () => void;
}) {
  const node = (
    <div className={full ? "fixed inset-0 z-[80] flex bg-[#EDEDED]" : "absolute inset-0 z-30 flex justify-center bg-black/40 px-4 py-8"}>
      <div className={full ? "relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-[#EDEDED] text-black" : "relative flex h-full min-h-0 w-full max-w-md flex-col overflow-hidden rounded-[28px] bg-[#EDEDED] text-black shadow-2xl"}>
        <div className="relative flex shrink-0 items-center px-4 py-3">
          <button type="button" className="absolute left-4" aria-label={full ? "还原" : "全屏"} onClick={onFull}>
            {full ? <Minimize2 className="size-5" /> : <Maximize2 className="size-5" />}
          </button>
          {onMinimize ? (
            <button type="button" className="absolute left-11" aria-label="收起" onClick={onMinimize}>
              <Minus className="size-5" />
            </button>
          ) : null}
          <div className="w-full text-center text-[16px] font-medium">{title}</div>
          <button type="button" className="absolute right-4" aria-label="关闭" onClick={onClose}>
            <X className="size-5" />
          </button>
        </div>
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
          {children}
        </div>
        {footer ? <div className="shrink-0 border-t border-black/5 bg-[#F7F7F7] px-3 py-2">{footer}</div> : null}
        {overlay}
      </div>
    </div>
  );
  if (full) return createPortal(node, document.body);
  return node;
}

function Thread({
  chat,
  name,
  lines,
  openInner,
  toggleInner,
  picked,
  onPick,
  onRegen,
  onEdit,
  readOnly,
}: {
  chat: Chat;
  name: string;
  lines: WechatLine[];
  openInner: Record<string, boolean>;
  toggleInner: (id: string) => void;
  picked?: string | null;
  onPick?: (id: string) => void;
  onRegen?: (id: string) => void;
  onEdit?: (line: WechatLine) => void;
  readOnly?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      {lines.map((line) =>
        line.role === "user" ? (
          <div key={line.id} className="flex flex-col items-end gap-1" onClick={() => onPick?.(line.id)}>
            {line.text.trim() ? <UserBubble text={line.text} /> : null}
            {line.attachments.map((a, i) => (
              <Shot key={`${a.blobId}-${i}`} blobId={a.blobId} />
            ))}
            {!readOnly && picked === line.id ? (
              <div className="flex gap-2 text-neutral-600" onClick={(e) => e.stopPropagation()}>
                <button type="button" aria-label="重新生成" onClick={() => onRegen?.(line.id)}>
                  <RefreshCw className="size-4" />
                </button>
                <button type="button" aria-label="编辑" onClick={() => onEdit?.(line)}>
                  <Pencil className="size-4" />
                </button>
              </div>
            ) : null}
          </div>
        ) : (
          <div key={line.id} className="flex items-start gap-2">
            <ChatAvatar chat={chat} name={name} size={32} />
            <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
              {line.text.trim() ? <HerBubble text={line.text} /> : null}
              {line.attachments.map((a, i) => (
                <Shot key={`${a.blobId}-${i}`} blobId={a.blobId} />
              ))}
              {lineImages(line).length ? <WechatShot chat={chat} lineId={line.id} images={lineImages(line)} readOnly={readOnly} /> : null}
              {line.inner ? (
                <button type="button" className="text-[12px] text-neutral-500" onClick={() => toggleInner(line.id)}>
                  {openInner[line.id] ? "收起内心" : "内心"}
                </button>
              ) : null}
              {line.inner && openInner[line.id] ? (
                <div className="max-w-[85%] whitespace-pre-wrap rounded-md bg-white/80 px-2 py-1 text-[12px] leading-relaxed text-neutral-700">
                  {line.inner}
                </div>
              ) : null}
            </div>
          </div>
        ),
      )}
    </div>
  );
}

function UserBubble({ text }: { text: string }) {
  return <div className="max-w-[75%] rounded-[6px] bg-[#95EC69] px-3 py-2 text-[15px] leading-snug text-black">{text}</div>;
}

function HerBubble({ text }: { text: string }) {
  return <div className="max-w-[75%] rounded-[6px] bg-white px-3 py-2 text-[15px] leading-snug text-black">{text}</div>;
}

function Shot({ blobId }: { blobId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let dead = false;
    void imageUrl(blobId).then((u) => {
      if (!dead) setUrl(u);
    });
    return () => {
      dead = true;
    };
  }, [blobId]);
  if (!url) return <div className="h-24 w-24 rounded-[4px] bg-white" />;
  return <img src={url} alt="" className="max-h-40 max-w-[70%] rounded-[4px] object-contain" />;
}

function WechatShot({ chat, lineId, images, readOnly }: { chat: Chat; lineId: string; images: GenImage[]; readOnly?: boolean }) {
  const done = images.filter((g) => g.status === "done" && g.blobId);
  const pending = images.find((g) => g.status !== "done" && g.status !== "error");
  const [idx, setIdx] = useState(() => Math.max(0, done.length - 1));
  const [url, setUrl] = useState<string | null>(null);
  const [kick, setKick] = useState<GenImage["source"] | null>(null);
  const [saved, setSaved] = useState(false);
  const [flashErr, setFlashErr] = useState<string | null>(null);
  const prevDone = useRef(done.length);
  const seenFail = useRef("");
  const current = done[idx] ?? done[done.length - 1];
  const latest = images.at(-1);
  const failed = latest?.status === "error" ? latest : undefined;
  const busy = kick ?? pending?.source ?? null;
  const phase = genPhaseLabel(pending?.status) || (kick === "rewrite" || kick === "auto" ? "写提示词中" : kick ? "上传中" : "");
  const locked = Boolean(pending) || Boolean(kick);

  useEffect(() => {
    if (!pending) setKick(null);
  }, [pending]);

  useEffect(() => {
    if (done.length > prevDone.current) setIdx(done.length - 1);
    else if (idx >= done.length && done.length > 0) setIdx(done.length - 1);
    prevDone.current = done.length;
  }, [done.length, idx]);

  useEffect(() => {
    let gone = false;
    if (current?.blobId) {
      void imageUrl(current.blobId).then((u) => {
        if (!gone) setUrl(u);
      });
    } else setUrl(null);
    return () => {
      gone = true;
    };
  }, [current?.blobId]);

  useEffect(() => {
    if (pending || !failed || !current?.blobId) {
      if (!failed) setFlashErr(null);
      return;
    }
    if (seenFail.current === failed.id) return;
    seenFail.current = failed.id;
    setFlashErr(genPhaseLabel("error", failed.error));
    const t = window.setTimeout(() => setFlashErr(null), 2000);
    return () => window.clearTimeout(t);
  }, [pending, failed, current?.blobId]);

  const run = (mode: "same" | "rewrite") => {
    setKick(mode);
    void paintWechat(chat, lineId, mode).finally(() => setKick(null));
  };

  const openCustom = () => {
    const src = pending && (pending.prompt || pending.charTails) ? pending : current ?? pending;
    if (!src) return;
    useApp.getState().setUI({
      customPrompt: {
        chatId: chat.id,
        msgId: lineId,
        wechatLineId: lineId,
        imgId: src.id,
        text: extractGrokTail(src.prompt, chat.imageParams) || src.prompt || "",
        charTails: { ...(src.charTails || {}) },
      },
    });
  };

  return (
    <div className="w-full">
      {current ? (
        <div className="mb-1 flex flex-wrap gap-x-1.5 text-[10px] text-neutral-500">
          <span>{modelLabel(current.model)}</span>
          <span>
            {current.width}×{current.height}
          </span>
          <span>{current.steps}步</span>
          <span>{samplerLabel(current.sampler)}</span>
        </div>
      ) : null}
      <div className="relative max-w-[240px] overflow-hidden rounded-[14px] bg-neutral-200">
        {current && url ? (
          <div className="relative">
            <img src={url} alt="" className="w-full" />
            {done.length > 1 ? (
              <>
                <button type="button" className="absolute inset-y-0 left-0 w-1/2" aria-label="上一张" onClick={() => setIdx((i) => (i - 1 + done.length) % done.length)} />
                <button type="button" className="absolute inset-y-0 right-0 w-1/2" aria-label="下一张" onClick={() => setIdx((i) => (i + 1) % done.length)} />
              </>
            ) : null}
          </div>
        ) : (
          <div className="grid place-items-center px-2 text-[12px] text-neutral-500" style={{ aspectRatio: `${chat.imageParams.width} / ${chat.imageParams.height}` }}>
            {pending || kick ? (
              <span className="flex items-center gap-2">
                <Loader2 className="size-3.5 animate-spin" />
                {phase || "准备中"}
                {!readOnly ? (
                  <button type="button" className="text-red-500" onClick={() => cancelWechatImage(chat.id, lineId)}>
                    取消
                  </button>
                ) : null}
              </span>
            ) : failed ? (
              <span className="text-center text-red-500">{genPhaseLabel("error", failed.error)}</span>
            ) : (
              "还没有图"
            )}
          </div>
        )}
      </div>
      {flashErr ? <div className="mt-1 truncate text-center text-[10px] leading-4 text-red-500">{flashErr}</div> : null}
      {!readOnly ? (
        <div className="mt-1.5 grid grid-cols-4 text-center text-[10px] leading-none text-neutral-500">
          <ShotBtn
            icon={<RefreshCw className="size-3.5" />}
            label={busy === "same" && phase ? phase : "重新生成"}
            busy={busy === "same"}
            disabled={locked || !current}
            onClick={() => {
              if (busy === "same") {
                cancelWechatImage(chat.id, lineId);
                return;
              }
              if (locked || !current) return;
              run("same");
            }}
          />
          <ShotBtn
            icon={<Sparkles className="size-3.5" />}
            label={(busy === "rewrite" || busy === "auto") && phase ? phase : "换提示词生成"}
            busy={busy === "rewrite" || busy === "auto"}
            disabled={locked}
            onClick={() => {
              if (busy === "rewrite" || busy === "auto") {
                cancelWechatImage(chat.id, lineId);
                return;
              }
              if (locked) return;
              run("rewrite");
            }}
          />
          <ShotBtn
            icon={saved ? <Check className="size-3.5 text-good" /> : <Download className="size-3.5" />}
            label="下载"
            disabled={!current?.blobId}
            onClick={() => {
              if (!current?.blobId) return;
              void imageUrl(current.blobId).then(async (u) => {
                if (!u) return;
                const blob = await fetch(u).then((r) => r.blob());
                downloadBlob(blob, String(current.seed));
                setSaved(true);
                window.setTimeout(() => setSaved(false), 1000);
              });
            }}
          />
          <ShotBtn
            icon={<Wand2 className="size-3.5" />}
            label={busy === "custom" && phase ? phase : "自定义修改"}
            busy={busy === "custom"}
            disabled={!current && !pending}
            onClick={openCustom}
          />
        </div>
      ) : null}
    </div>
  );
}

function ShotBtn({
  icon,
  label,
  onClick,
  busy,
  disabled,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  busy?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy ? false : disabled}
      className={busy ? "flex min-w-0 flex-col items-center gap-1 px-0.5 py-1 text-primary" : "flex min-w-0 flex-col items-center gap-1 px-0.5 py-1 disabled:opacity-40"}
    >
      {busy ? <Loader2 className="size-3.5 shrink-0 animate-spin" /> : icon}
      <span className="whitespace-nowrap">{label}</span>
    </button>
  );
}

function PendingThumb({ blobId, mark, onRemove }: { blobId: string; mark?: string; onRemove: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let dead = false;
    void imageUrl(blobId).then((u) => {
      if (!dead) setUrl(u);
    });
    return () => {
      dead = true;
    };
  }, [blobId]);
  return (
    <div className="relative shrink-0">
      {url ? <img src={url} alt="" className="h-16 w-14 rounded-md object-cover" /> : <div className="h-16 w-14 rounded-md bg-white" />}
      {mark ? <span className="absolute bottom-0 left-0 bg-black/50 px-1 text-[10px] text-white">{mark}</span> : null}
      <button type="button" className="absolute -right-1 -top-1 grid size-5 place-items-center rounded-full bg-white text-black" onClick={onRemove} aria-label="去掉">
        <X className="size-3" />
      </button>
    </div>
  );
}

function EmojiPanel({
  tab,
  setTab,
  stickers,
  onEmoji,
  onSticker,
  onDeleteSticker,
  onAddSticker,
}: {
  tab: "emoji" | "heart";
  setTab: (t: "emoji" | "heart") => void;
  stickers: string[];
  onEmoji: (ch: string) => void;
  onSticker: (blobId: string) => void;
  onDeleteSticker: (blobId: string) => void;
  onAddSticker: (blobId: string) => void;
}) {
  return (
    <div className="mt-2 border-t border-black/5 pt-2">
      <div className="mb-2 flex gap-4 text-[14px]">
        <button type="button" className={tab === "emoji" ? "text-red-500" : "text-neutral-500"} onClick={() => setTab("emoji")}>
          Emoji
        </button>
        <button type="button" className={tab === "heart" ? "text-red-500" : "text-neutral-500"} onClick={() => setTab("heart")}>
          ♥
        </button>
      </div>
      {tab === "emoji" ? (
        <div className="grid max-h-36 grid-cols-8 gap-1 overflow-y-auto">
          {EMOJI.map((ch) => (
            <button key={ch} type="button" className="py-1 text-[22px]" onClick={() => onEmoji(ch)}>
              {ch}
            </button>
          ))}
        </div>
      ) : (
        <div className="grid max-h-36 grid-cols-4 gap-2 overflow-y-auto">
          <ImagePick
            onFile={(file) => {
              void compressRef(file, 512, 0.85).then(async (blob) => onAddSticker(await saveBlob(blob)));
            }}
            render={(open) => (
              <button type="button" className="grid aspect-square place-items-center rounded-md border border-dashed border-neutral-300 text-neutral-500" onClick={open} aria-label="上传表情包">
                <Plus className="size-5" />
              </button>
            )}
          />
          {stickers.map((id) => (
            <StickerTile key={id} blobId={id} onPick={() => onSticker(id)} onDelete={() => onDeleteSticker(id)} />
          ))}
        </div>
      )}
    </div>
  );
}

function StickerTile({ blobId, onPick, onDelete }: { blobId: string; onPick: () => void; onDelete: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const timer = useRef<number>(0);
  const skip = useRef(false);
  useEffect(() => {
    let dead = false;
    void imageUrl(blobId).then((u) => {
      if (!dead) setUrl(u);
    });
    return () => {
      dead = true;
    };
  }, [blobId]);
  return (
    <button
      type="button"
      className="aspect-square overflow-hidden rounded-md bg-white"
      onClick={() => {
        if (skip.current) {
          skip.current = false;
          return;
        }
        onPick();
      }}
      onPointerDown={() => {
        skip.current = false;
        timer.current = window.setTimeout(() => {
          skip.current = true;
          onDelete();
        }, 500);
      }}
      onPointerUp={() => window.clearTimeout(timer.current)}
      onPointerLeave={() => window.clearTimeout(timer.current)}
    >
      {url ? <img src={url} alt="" className="size-full object-contain" /> : null}
    </button>
  );
}

async function addFiles(files: File[], add: (items: WechatAttach[]) => void) {
  const items: WechatAttach[] = [];
  for (const file of files) {
    if (!isImageFile(file)) continue;
    const blob = await compressRef(file, 1024, 0.85);
    items.push({ blobId: await saveBlob(blob), kind: "photo" });
  }
  if (items.length) add(items);
}

async function addBlobs(ids: string[], kind: WechatAttach["kind"], add: (items: WechatAttach[]) => void) {
  const items: WechatAttach[] = [];
  for (const id of ids) {
    const blob = await getImage(id);
    if (!blob) continue;
    items.push({ blobId: await saveBlob(blob), kind });
  }
  if (!items.length && ids.length) {
    useApp.getState().toast("这张图已经不在了");
    return;
  }
  add(items);
}
