import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { ArrowUp, ChevronLeft, Plus, Smile, X } from "lucide-react";
import { getImage, imageUrl } from "@/lib/idb";
import { compressRef, isImageFile } from "@/lib/ref-image";
import { saveBlob, useApp } from "@/lib/store";
import type { Chat, WechatAttach, WechatLine, WechatLog, WechatSession } from "@/lib/types";
import { emptyWechatSession, sendWechat, summarizeWechat, wechatTurnText } from "@/lib/wechat";
import { uid } from "@/lib/utils";
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
  if (session) return <WechatLive chat={chat} session={session} />;
  if (!view) return null;
  const msg = chat.messages.find((m) => m.id === view.msgId);
  if (!msg?.wechatLog) return null;
  return (
    <WechatRead
      chat={chat}
      log={msg.wechatLog}
      onClose={() => useApp.getState().setUI({ wechatView: null })}
    />
  );
}

export function openWechat(chat: Chat) {
  if (useApp.getState().wechatSessions[chat.id]) return;
  useApp.getState().setUI({ wechatView: null });
  useApp.getState().setWechatSession(chat.id, emptyWechatSession(chat.characters[0]?.id || ""));
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
  const name = char?.name.trim() || chat.name || "她";

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [session.lines.length, phase, session.pending.length]);

  const patch = (p: Partial<WechatSession>) => {
    const cur = useApp.getState().wechatSessions[chat.id];
    if (!cur) return;
    useApp.getState().setWechatSession(chat.id, { ...cur, ...p });
  };

  const addPending = (items: WechatAttach[]) => {
    const cur = useApp.getState().wechatSessions[chat.id];
    if (!cur) return;
    const room = 9 - cur.pending.length;
    if (room <= 0) {
      useApp.getState().toast("最多 9 张");
      return;
    }
    if (items.length > room) useApp.getState().toast("最多 9 张");
    patch({ pending: [...cur.pending, ...items.slice(0, room)] });
  };

  const send = () => {
    if (phase !== "idle") return;
    const cur = useApp.getState().wechatSessions[chat.id];
    if (!cur || (!cur.draft.trim() && !cur.pending.length)) return;
    setPhase("type");
    setEmoji(false);
    void sendWechat(chat, () => setPhase("idle"));
  };

  const close = () => {
    const cur = useApp.getState().wechatSessions[chat.id];
    if (!cur || !cur.lines.length) {
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
    const log: WechatLog = {
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
      scrollRef={scroller}
      overlay={
        ask ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/30 px-8">
            <div className="w-full rounded-2xl bg-white p-4 text-black">
              <div className="mb-4 text-[15px]">{ask === "close" ? "是否保存当前微信内容到聊天" : "总结没写成"}</div>
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
          {session.pending.length ? (
            <div className="mb-2 flex gap-2 overflow-x-auto">
              {session.pending.map((item, i) => (
                <PendingThumb
                  key={`${item.blobId}-${i}`}
                  blobId={item.blobId}
                  mark={item.kind === "sticker" ? "表情" : ""}
                  onRemove={() => patch({ pending: session.pending.filter((_, at) => at !== i) })}
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
          {chat.isMulti && !session.lines.length ? (
            <div className="mb-2 flex gap-1.5 overflow-x-auto">
              {chat.characters.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={`shrink-0 rounded-full border px-2 py-0.5 text-[12px] ${c.id === session.charId ? "border-red-500 text-red-500" : "border-neutral-300 text-neutral-500"}`}
                  onClick={() => patch({ charId: c.id })}
                >
                  {c.name.trim() || "角色"}
                </button>
              ))}
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
              value={session.draft}
              rows={1}
              className="max-h-24 min-h-9 flex-1 resize-none rounded-md bg-white px-3 py-2 text-[15px] text-black outline-none"
              onChange={(e) => patch({ draft: e.target.value })}
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
              disabled={phase !== "idle" || (!session.draft.trim() && !session.pending.length)}
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
      <Thread chat={chat} name={name} lines={session.lines} openInner={openInner} toggleInner={(id) => setOpenInner((m) => ({ ...m, [id]: !m[id] }))} />
      {phase === "sum" ? <div className="py-2 text-center text-[12px] text-neutral-500">正在总结</div> : null}
    </Shell>
  );
}

function WechatRead({ chat, log, onClose }: { chat: Chat; log: WechatLog; onClose: () => void }) {
  const [openInner, setOpenInner] = useState<Record<string, boolean>>({});
  return (
    <Shell title={log.charName || "微信"} onClose={onClose}>
      <Thread
        chat={chat}
        name={log.charName}
        lines={log.lines}
        openInner={openInner}
        toggleInner={(id) => setOpenInner((m) => ({ ...m, [id]: !m[id] }))}
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
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  overlay?: ReactNode;
  scrollRef?: RefObject<HTMLDivElement | null>;
}) {
  return (
    <div className="absolute inset-0 z-30 flex justify-center bg-black/40 px-4 py-8">
      <div className="relative flex h-full min-h-0 w-full max-w-md flex-col overflow-hidden rounded-[28px] bg-[#EDEDED] text-black shadow-2xl">
        <div className="relative flex shrink-0 items-center px-4 py-3">
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
}

function Thread({
  chat,
  name,
  lines,
  openInner,
  toggleInner,
}: {
  chat: Chat;
  name: string;
  lines: WechatLine[];
  openInner: Record<string, boolean>;
  toggleInner: (id: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      {lines.map((line) =>
        line.role === "user" ? (
          <div key={line.id} className="flex flex-col items-end gap-1">
            {line.text.trim() ? <UserBubble text={line.text} /> : null}
            {line.attachments.map((a, i) => (
              <Shot key={`${a.blobId}-${i}`} blobId={a.blobId} />
            ))}
          </div>
        ) : (
          <div key={line.id} className="flex items-start gap-2">
            <ChatAvatar chat={chat} name={name} size={32} />
            <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
              {line.text.trim() ? <HerBubble text={line.text} /> : null}
              {line.attachments.map((a, i) => (
                <Shot key={`${a.blobId}-${i}`} blobId={a.blobId} />
              ))}
              {line.gen ? <GenShot chat={chat} gen={line.gen} /> : null}
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

function GenShot({ chat, gen }: { chat: Chat; gen: NonNullable<WechatLine["gen"]> }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (gen.status !== "done" || !gen.blobId) return;
    let dead = false;
    void imageUrl(gen.blobId).then((u) => {
      if (!dead) setUrl(u);
    });
    return () => {
      dead = true;
    };
  }, [gen.status, gen.blobId]);
  return (
    <div
      className="overflow-hidden rounded-[4px] bg-white"
      style={{ width: 140, aspectRatio: `${chat.imageParams.width} / ${chat.imageParams.height}` }}
    >
      {url ? <img src={url} alt="" className="size-full object-cover" /> : <div className="grid size-full place-items-center text-[12px] text-neutral-400">{gen.status === "error" ? "没画成" : "画着"}</div>}
    </div>
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
