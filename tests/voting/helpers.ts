import type { VoteExecutorInput } from "../../src/core/ports.js";
import type { Anchor } from "../../src/core/schema.js";
import { mockReply, type MockStep } from "../../src/voting/provider/mock.js";

export function anchor(anchor_path: string, kind: Anchor["kind"] = "code"): Anchor {
  return { kind, anchor: anchor_path };
}

/** 确定性 RNG（同一 seed → 同一序列），用于置换复现测试。 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const verifyAll = async (): Promise<boolean> => true;

export function verifyOnly(known: string[]): (a: Anchor) => Promise<boolean> {
  return async (a) => known.includes(a.anchor);
}

/** 一条合法判定响应。 */
export function voteReply(
  conclusion: string,
  anchors: Anchor[],
  reason = `${conclusion} 有直接证据支撑`,
  confidence = 0.9,
): MockStep {
  return mockReply({ conclusion, anchors, confidence, reason });
}

export function makeInput(args: {
  voters: VoteExecutorInput["voters"];
  machine_verifiable?: boolean;
  verify_anchor?: (a: Anchor) => Promise<boolean>;
  options?: string[];
}): VoteExecutorInput {
  return {
    decision_point: {
      id: "D-0001",
      question: "gate 的触发条件是否只由 attach.triggers 声明决定？",
      options: args.options ?? ["选项A", "选项B"],
      machine_verifiable: args.machine_verifiable ?? true,
      context_pack: "read-only snapshot @ commit deadbeef",
    },
    voters: args.voters,
    verify_anchor: args.verify_anchor ?? verifyAll,
  };
}
