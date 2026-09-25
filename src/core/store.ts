/**
 * JsonlEventStore：唯一写路径（ADR-0020 决策 2、ADR-0010 注意点 2）。
 *
 * - 单写者、进程内 async 串行队列：并发 append 被串行化，seq 无重复；
 * - seq = 本写者血统内 last + 1；prev_event_hash = 本链上一事件的内容哈希（首事件 null）；
 * - 单行 JSON 原子追加（O_APPEND + 单次 write + fsync），**落盘成功后**才向订阅者派发；
 * - 打开时修复「未写完的行」（无结尾换行的残行）——按原子边界口径，它从未「发生」；
 *   若末行是合法事件只是丢了结尾换行，则补换行而不是丢弃（合并产物可能没有结尾换行）。
 */
import { constants } from "node:fs";
import { access, mkdir, open as openFile, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { monotonicFactory } from "ulid";
import type { EventStore } from "./ports.js";
import {
  EventDraftSchema,
  EventEnvelopeSchema,
  type EventDraft,
  type EventEnvelope,
} from "./schema.js";
import { canonicalJson, hashEvent, orderEvents } from "./hash.js";

const nextMonotonicUlid = monotonicFactory();

export type EventStoreNoteKind = "truncated_tail" | "repaired_tail" | "unparsable_line";

export interface EventStoreNote {
  kind: EventStoreNoteKind;
  detail: string;
}

export interface JsonlEventStoreOptions {
  sessionId: string;
  filePath: string;
  /** 测试接缝：事件 id 生成器（默认单调 ULID，ADR-0020 注意点 1） */
  newEventId?: () => string;
  /** 测试接缝：时钟（默认系统时间；timestamp 由写者分配并规范化） */
  now?: () => Date;
  /** 测试接缝：落盘实现（默认 open 'a' + 单次 write + fsync） */
  persistLine?: (filePath: string, line: string) => Promise<void>;
}

export interface EventStoreDiagnostics {
  notes: EventStoreNote[];
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function persistLineToDisk(filePath: string, line: string): Promise<void> {
  const handle = await openFile(filePath, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY);
  try {
    // 单次 write + O_APPEND：本地文件系统下整行追加原子（ADR-0020 注意点 2）
    await handle.write(line, null, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class JsonlEventStore implements EventStore {
  readonly sessionId: string;
  readonly filePath: string;

  private readonly newEventId: () => string;
  private readonly now: () => Date;
  private readonly persistLine: (filePath: string, line: string) => Promise<void>;
  private readonly handlers = new Set<(event: EventEnvelope) => void>();
  private readonly notes: EventStoreNote[] = [];

  private queue: Promise<unknown> = Promise.resolve();
  private lastSeq = 0;
  private lastHash: string | null = null;

  private constructor(options: JsonlEventStoreOptions) {
    this.sessionId = options.sessionId;
    this.filePath = options.filePath;
    this.newEventId = options.newEventId ?? (() => nextMonotonicUlid());
    this.now = options.now ?? (() => new Date());
    this.persistLine = options.persistLine ?? persistLineToDisk;
  }

  /** 打开（或创建）某个 session 的事件流；顺带修复未写完的残行并继承链尾 */
  static async open(options: JsonlEventStoreOptions): Promise<JsonlEventStore> {
    const store = new JsonlEventStore(options);
    await mkdir(dirname(options.filePath), { recursive: true });
    if (!(await exists(options.filePath))) {
      await writeFile(options.filePath, "", "utf8");
    }
    await store.recover();
    return store;
  }

  async append(draft: EventDraft): Promise<EventEnvelope> {
    const run = this.queue.then(() => this.appendSerialized(draft));
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async readAll(): Promise<EventEnvelope[]> {
    const lines = await this.readCompleteLines();
    return lines.map((line) => line.event);
  }

  async readOrdered(): Promise<EventEnvelope[]> {
    return orderEvents(await this.readAll());
  }

  subscribe(handler: (event: EventEnvelope) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /** 读侧诊断：截断残行 / 无法解析的整行（doctor 用来让「丢事件」可见） */
  diagnostics(): EventStoreDiagnostics {
    return { notes: this.notes.map((note) => ({ ...note })) };
  }

  private async appendSerialized(draft: EventDraft): Promise<EventEnvelope> {
    const parsed = EventDraftSchema.parse(draft);
    if (parsed.session_id !== this.sessionId) {
      throw new Error(
        `session_id 不匹配：事件属于 ${parsed.session_id}，本 store 写 ${this.sessionId}`,
      );
    }
    const event = EventEnvelopeSchema.parse({
      ...parsed,
      seq: this.lastSeq + 1,
      prev_event_hash: this.lastHash,
      timestamp: this.now().toISOString(),
    });
    const line = `${canonicalJson(event)}\n`;
    await this.persistLine(this.filePath, line);
    this.lastSeq = event.seq;
    this.lastHash = hashEvent(event);
    this.dispatch(event);
    return event;
  }

  /** 事件已落盘后才派发；订阅者异常不影响已发生的事实 */
  private dispatch(event: EventEnvelope): void {
    for (const handler of [...this.handlers]) {
      try {
        handler(event);
      } catch {
        // 派发是进程内通知，不是事实来源；单个订阅者崩溃不回滚落盘。
      }
    }
  }

  private async recover(): Promise<void> {
    const text = await readFile(this.filePath, "utf8");
    if (text.length > 0 && !text.endsWith("\n")) {
      const boundary = text.lastIndexOf("\n");
      const fragment = boundary === -1 ? text : text.slice(boundary + 1);
      if (this.isCompleteEvent(fragment)) {
        // 末行是合法事件、只是缺结尾换行（例如 merge driver 覆写时去掉了换行）：补换行，不丢事件
        await writeFile(this.filePath, `${text}\n`, "utf8");
        this.pushNote("repaired_tail", "末行事件缺少结尾换行，已补换行（未丢事件）");
      } else {
        const keep = boundary === -1 ? "" : text.slice(0, boundary + 1);
        this.pushNote(
          "truncated_tail",
          `丢弃未写完的残行 ${text.length - keep.length} 字节（写入未落盘即崩溃，按原子边界不算事件）`,
        );
        await writeFile(this.filePath, keep, "utf8");
      }
    }
    const lines = await this.readCompleteLines();
    const tail = lines[lines.length - 1];
    if (tail !== undefined) {
      this.lastSeq = tail.event.seq;
      this.lastHash = hashEvent(tail.event);
    }
  }

  private isCompleteEvent(fragment: string): boolean {
    if (fragment.trim().length === 0) return false;
    if (!fragment.endsWith("}")) return false;
    try {
      return EventEnvelopeSchema.safeParse(JSON.parse(fragment)).success;
    } catch {
      return false;
    }
  }

  private async readCompleteLines(): Promise<Array<{ event: EventEnvelope }>> {
    const text = await readFile(this.filePath, "utf8");
    const events: Array<{ event: EventEnvelope }> = [];
    const lines = text.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line === undefined || line.trim().length === 0) continue;
      const isLast = index === lines.length - 1;
      let decoded: unknown;
      try {
        decoded = JSON.parse(line);
      } catch {
        if (isLast) {
          this.pushNote("truncated_tail", `第 ${index + 1} 行是无法解析的残行（无结尾换行）`);
        } else {
          this.pushNote("unparsable_line", `第 ${index + 1} 行不是合法 JSON`);
        }
        continue;
      }
      const parsed = EventEnvelopeSchema.safeParse(decoded);
      if (!parsed.success) {
        this.pushNote("unparsable_line", `第 ${index + 1} 行不符合 EventEnvelope v1`);
        continue;
      }
      events.push({ event: parsed.data });
    }
    return events;
  }

  private pushNote(kind: EventStoreNoteKind, detail: string): void {
    if (this.notes.some((note) => note.kind === kind && note.detail === detail)) return;
    this.notes.push({ kind, detail });
  }
}
