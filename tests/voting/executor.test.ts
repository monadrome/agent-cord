import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import type { Anchor } from "../../src/core/schema.js";
import type { VoteExecutorInput } from "../../src/core/ports.js";
import {
  ABSTAIN_OPTION,
  buildSystemPrompt,
  canonicalOptions,
  createVoteExecutor,
  hashPrompt,
  type BallotAudit,
} from "../../src/voting/executor.js";
import { MockProvider, mockFailure, mockReply } from "../../src/voting/provider/mock.js";
import { anchor, makeInput, mulberry32, verifyOnly, voteReply } from "./helpers.js";

const MODEL_A = "model-a-2026-01-01";
const MODEL_B = "model-b-2026-01-01";
const MODEL_C = "model-c-2026-01-01";

function twoVoters(a: MockProvider, b: MockProvider): VoteExecutorInput["voters"] {
  return [
    { agent_id: "reviewer-a", adapter: a, model_id: MODEL_A },
    { agent_id: "reviewer-b", adapter: b, model_id: MODEL_B },
  ];
}

describe("createVoteExecutor / 判定路径", () => {
  it("k=2 全票一致 + 可机验 + 锚点独立 → confirmed", async () => {
    const a = new MockProvider({ provider: "provider-a", by_model_id: { [MODEL_A]: [voteReply("选项A", [anchor("src/x.ts#X.a")])] } });
    const b = new MockProvider({ provider: "provider-b", by_model_id: { [MODEL_B]: [voteReply("选项A", [anchor("tests/y.test.ts#case-1", "test")])] } });

    const record = await createVoteExecutor({ rng: mulberry32(1) }).run(makeInput({ voters: twoVoters(a, b) }));

    expect(record.verdict).toBe("confirmed");
    expect(record.k).toBe(2);
    expect(record.vote_id).toBe("V-1");
    expect(record.ballots.map((ballot) => ballot.conclusion)).toEqual(["选项A", "选项A"]);
    expect(record.ballots.map((ballot) => ballot.provider)).toEqual(["provider-a", "provider-b"]);
    expect(record.stats.raw_agreement).toBe(1);
    expect(record.stats.anchor_overlap).toBe(0);
    expect(record.minority).toBeNull();
    expect(record.decision_point.options).toEqual(["选项A", "选项B", ABSTAIN_OPTION]);
    expect(a.requests[0]?.temperature).toBe(0);
    expect(b.requests[0]?.temperature).toBe(0);
  });

  it("响应缺 reason / confidence 仍按契约容错（薄编排层的 demo 形态）", async () => {
    const a = new MockProvider({ provider: "mock-a", responses: [{ parsed_json: { conclusion: "选项A", anchors: [anchor("src/a.ts#A")], confidence: 0.9 } }] });
    const b = new MockProvider({ provider: "mock-b", responses: [{ parsed_json: { conclusion: "选项A", anchors: [anchor("src/b.ts#B")] } }] });

    const record = await createVoteExecutor({ rng: mulberry32(21) }).run(makeInput({ voters: twoVoters(a, b) }));

    expect(record.verdict).toBe("confirmed");
    expect(record.ballots[1]?.confidence).toBe(0);
  });

  it("k=3 全票一致 + 可机验 + 锚点各自独立 → confirmed", async () => {
    const adapters = [MODEL_A, MODEL_B, MODEL_C].map(
      (model_id, index) =>
        new MockProvider({
          provider: `provider-${index}`,
          by_model_id: { [model_id]: [voteReply("选项B", [anchor(`src/m${index}.ts#Sym${index}`)])] },
        }),
    );
    const voters = adapters.map((adapter, index) => ({ agent_id: `reviewer-${index}`, adapter, model_id: [MODEL_A, MODEL_B, MODEL_C][index] ?? "" }));

    const record = await createVoteExecutor({ rng: mulberry32(2) }).run(makeInput({ voters }));

    expect(record.verdict).toBe("confirmed");
    expect(record.k).toBe(3);
    expect(record.stats.raw_agreement).toBe(1);
  });

  it("语义类（machine_verifiable=false）即使全票一致也落 needs_verification", async () => {
    const a = new MockProvider({ by_model_id: { [MODEL_A]: [voteReply("选项A", [anchor("src/x.ts#X.a")])] } });
    const b = new MockProvider({ by_model_id: { [MODEL_B]: [voteReply("选项A", [anchor("src/y.ts#Y.b")])] } });

    const record = await createVoteExecutor({ rng: mulberry32(3) }).run(
      makeInput({ voters: twoVoters(a, b), machine_verifiable: false }),
    );

    expect(record.verdict).toBe("needs_verification");
    expect(record.stats.anchor_overlap).toBe(0);
    expect(record.minority).toBeNull();
  });

  it("一致但锚点重合（Jaccard = 1）→ escalated_anchor_overlap，优先级高于 confirmed", async () => {
    const same = [anchor("src/x.ts#X.a")];
    const a = new MockProvider({ by_model_id: { [MODEL_A]: [voteReply("选项A", same)] } });
    const b = new MockProvider({ by_model_id: { [MODEL_B]: [voteReply("选项A", same)] } });

    const record = await createVoteExecutor({ rng: mulberry32(4) }).run(makeInput({ voters: twoVoters(a, b) }));

    expect(record.verdict).toBe("escalated_anchor_overlap");
    expect(record.stats.anchor_overlap).toBe(1);
  });

  it("一致但一方锚点为另一方子集（Jaccard 低于阈值）→ escalated_anchor_overlap", async () => {
    const a = new MockProvider({ by_model_id: { [MODEL_A]: [voteReply("选项A", [anchor("src/x.ts#X.a")])] } });
    const b = new MockProvider({
      by_model_id: {
        [MODEL_B]: [voteReply("选项A", [anchor("src/x.ts#X.a"), anchor("src/y.ts#Y.b"), anchor("src/z.ts#Z.c")])],
      },
    });

    const record = await createVoteExecutor({ rng: mulberry32(5) }).run(makeInput({ voters: twoVoters(a, b) }));

    expect(record.verdict).toBe("escalated_anchor_overlap");
    expect(record.stats.anchor_overlap).toBeCloseTo(1 / 3, 10);
  });

  it("k=3 分歧 2:1 → needs_verification + 少数派理由留痕", async () => {
    const a = new MockProvider({ by_model_id: { [MODEL_A]: [voteReply("选项A", [anchor("src/a.ts#A")])] } });
    const b = new MockProvider({ by_model_id: { [MODEL_B]: [voteReply("选项A", [anchor("src/b.ts#B")])] } });
    const c = new MockProvider({
      by_model_id: {
        [MODEL_C]: [voteReply("选项B", [anchor("src/c.ts#C")], "节点进入也会触发门禁，attach.triggers 只是可选过滤器")],
      },
    });
    const voters = [
      { agent_id: "reviewer-a", adapter: a, model_id: MODEL_A },
      { agent_id: "reviewer-b", adapter: b, model_id: MODEL_B },
      { agent_id: "reviewer-c", adapter: c, model_id: MODEL_C },
    ];

    const record = await createVoteExecutor({ rng: mulberry32(6) }).run(makeInput({ voters }));

    expect(record.verdict).toBe("needs_verification");
    expect(record.stats.raw_agreement).toBeCloseTo(2 / 3, 10);
    expect(record.minority).not.toBeNull();
    expect(record.minority?.conclusion).toBe("选项B");
    expect(record.minority?.reason).toContain("attach.triggers");
    expect(record.minority?.anchors.map((a_) => a_.anchor)).toEqual(["src/c.ts#C"]);
  });

  it("k=2 一票弃权（兜底项）→ 有效票不足 2 → abstain，且无 minority", async () => {
    const a = new MockProvider({ by_model_id: { [MODEL_A]: [voteReply("选项A", [anchor("src/a.ts#A")])] } });
    const b = new MockProvider({ by_model_id: { [MODEL_B]: [voteReply(ABSTAIN_OPTION, [])] } });

    const record = await createVoteExecutor({ rng: mulberry32(7) }).run(makeInput({ voters: twoVoters(a, b) }));

    expect(record.verdict).toBe("abstain");
    expect(record.ballots.map((ballot) => ballot.conclusion)).toEqual(["选项A", ABSTAIN_OPTION]);
    expect(record.minority).toBeNull();
  });

  it("voter 数不在 2..3 时报错（k 值契约）", async () => {
    const a = new MockProvider();
    await expect(
      createVoteExecutor().run(makeInput({ voters: [{ agent_id: "only", adapter: a, model_id: MODEL_A }] })),
    ).rejects.toThrow(/2\.\.3/);
  });
});

describe("createVoteExecutor / 失败重试与弃权", () => {
  it("provider 连续失败两次 → 该票 abstain（不计入一致），有效票不足 2 → 整体 abstain", async () => {
    const a = new MockProvider({ by_model_id: { [MODEL_A]: [voteReply("选项A", [anchor("src/a.ts#A")])] } });
    const b = new MockProvider({ by_model_id: { [MODEL_B]: [mockFailure("502 upstream"), mockFailure("502 upstream")] } });
    const audits: BallotAudit[] = [];

    const record = await createVoteExecutor({ rng: mulberry32(8), on_ballot_audit: (audit) => audits.push(audit) }).run(
      makeInput({ voters: twoVoters(a, b) }),
    );

    expect(record.verdict).toBe("abstain");
    expect(b.calls).toBe(2);
    const failed = record.ballots[1];
    expect(failed?.conclusion).toBe(ABSTAIN_OPTION);
    expect(failed?.anchors).toEqual([]);
    expect(failed?.response_hash).toBeNull();
    expect(failed?.request_id).toBeNull();
    expect(failed?.confidence).toBe(0);
    expect(failed?.model_id).toBe(MODEL_B);
    expect(audits[1]?.status).toBe("abstain_provider_error");
    expect(audits[1]?.attempts).toBe(2);
    expect(audits[1]?.error).toContain("502");
  });

  it("首次失败、重试成功 → 该票正常计入（重试 1 次生效）", async () => {
    const a = new MockProvider({ by_model_id: { [MODEL_A]: [voteReply("选项A", [anchor("src/a.ts#A")])] } });
    const b = new MockProvider({
      by_model_id: { [MODEL_B]: [mockFailure("timeout"), voteReply("选项A", [anchor("src/b.ts#B")])] },
    });

    const record = await createVoteExecutor({ rng: mulberry32(9) }).run(makeInput({ voters: twoVoters(a, b) }));

    expect(b.calls).toBe(2);
    expect(record.verdict).toBe("confirmed");
    expect(record.ballots[1]?.response_hash).not.toBeNull();
  });

  it("结论落在选项集之外 → 视为解析失败，重试后仍失败则弃权", async () => {
    const a = new MockProvider({ by_model_id: { [MODEL_A]: [voteReply("选项A", [anchor("src/a.ts#A")])] } });
    const b = new MockProvider({
      by_model_id: {
        [MODEL_B]: [
          voteReply("以上都对", [anchor("src/b.ts#B")]),
          voteReply("以上都对", [anchor("src/b.ts#B")]),
        ],
      },
    });
    const audits: BallotAudit[] = [];

    const record = await createVoteExecutor({ rng: mulberry32(10), on_ballot_audit: (audit) => audits.push(audit) }).run(
      makeInput({ voters: twoVoters(a, b) }),
    );

    expect(b.calls).toBe(2);
    expect(record.verdict).toBe("abstain");
    expect(audits[1]?.status).toBe("abstain_invalid_output");
    expect(audits[1]?.error).toContain("outside option set");
  });

  it("结构化输出缺失（parsed_json 不可解析）→ 重试后弃权", async () => {
    const a = new MockProvider({ by_model_id: { [MODEL_A]: [voteReply("选项A", [anchor("src/a.ts#A")])] } });
    const b = new MockProvider({ by_model_id: { [MODEL_B]: [mockReply(undefined, { raw_text: "not json" }), mockReply(undefined, { raw_text: "not json" })] } });

    const record = await createVoteExecutor({ rng: mulberry32(11) }).run(makeInput({ voters: twoVoters(a, b) }));

    expect(record.verdict).toBe("abstain");
    expect(record.ballots[1]?.usage).toBeNull();
  });
});

describe("createVoteExecutor / 锚点机验", () => {
  it("不可机验的锚点被逐个剔除并记录，留存锚点仍参与判定", async () => {
    const good = anchor("src/a.ts#A");
    const bad = anchor("src/ghost.ts#Nope");
    const other = anchor("src/b.ts#B");
    const a = new MockProvider({ by_model_id: { [MODEL_A]: [voteReply("选项A", [good, bad])] } });
    const b = new MockProvider({ by_model_id: { [MODEL_B]: [voteReply("选项A", [other])] } });
    const audits: BallotAudit[] = [];

    const record = await createVoteExecutor({
      rng: mulberry32(12),
      on_ballot_audit: (audit) => audits.push(audit),
    }).run(
      makeInput({
        voters: twoVoters(a, b),
        verify_anchor: verifyOnly([good.anchor, other.anchor]),
      }),
    );

    expect(record.ballots[0]?.anchors.map((a_) => a_.anchor)).toEqual([good.anchor]);
    expect(audits[0]?.dropped_anchors.map((a_) => a_.anchor)).toEqual([bad.anchor]);
    expect(audits[0]?.status).toBe("ok");
    expect(record.verdict).toBe("confirmed");
  });

  it("锚点全被剔除且结论非兜底项 → 该票按 abstain 处理（结论归一化为兜底项）", async () => {
    const a = new MockProvider({ by_model_id: { [MODEL_A]: [voteReply("选项A", [anchor("src/ghost.ts#Nope")])] } });
    const b = new MockProvider({ by_model_id: { [MODEL_B]: [voteReply("选项A", [anchor("src/b.ts#B")])] } });
    const audits: BallotAudit[] = [];

    const record = await createVoteExecutor({
      rng: mulberry32(13),
      on_ballot_audit: (audit) => audits.push(audit),
    }).run(
      makeInput({ voters: twoVoters(a, b), verify_anchor: verifyOnly(["src/b.ts#B"]) }),
    );

    expect(audits[0]?.status).toBe("abstain_no_verifiable_anchor");
    expect(audits[0]?.conclusion).toBe("选项A");
    expect(audits[0]?.dropped_anchors).toHaveLength(1);
    expect(record.ballots[0]?.conclusion).toBe(ABSTAIN_OPTION);
    expect(record.ballots[0]?.anchors).toEqual([]);
    expect(record.verdict).toBe("abstain");
  });

  it("机验器抛错按「不可机验」处理，不打断投票", async () => {
    const a = new MockProvider({ by_model_id: { [MODEL_A]: [voteReply("选项A", [anchor("src/a.ts#A")])] } });
    const b = new MockProvider({ by_model_id: { [MODEL_B]: [voteReply("选项A", [anchor("src/b.ts#B")])] } });

    const record = await createVoteExecutor({ rng: mulberry32(14) }).run(
      makeInput({
        voters: twoVoters(a, b),
        verify_anchor: async (candidate: Anchor) => {
          if (candidate.anchor === "src/a.ts#A") throw new Error("verifier exploded");
          return true;
        },
      }),
    );

    expect(record.verdict).toBe("abstain");
    expect(record.ballots[0]?.anchors).toEqual([]);
  });
});

describe("createVoteExecutor / 盲评隔离与可复现", () => {
  it("每票独立请求：system/user prompt 不含其他 voter 的身份或结论", async () => {
    const a = new MockProvider({ by_model_id: { [MODEL_A]: [voteReply("选项A", [anchor("src/a.ts#A")])] } });
    const b = new MockProvider({ by_model_id: { [MODEL_B]: [voteReply("选项A", [anchor("src/b.ts#B")])] } });

    await createVoteExecutor({ rng: mulberry32(15) }).run(makeInput({ voters: twoVoters(a, b) }));

    const request_a = a.requests[0];
    const request_b = b.requests[0];
    expect(request_a?.system_prompt).not.toContain("reviewer-b");
    expect(request_a?.system_prompt).not.toContain(MODEL_B);
    expect(request_b?.system_prompt).not.toContain("reviewer-a");
    // 每票只拿到自己这一份净输入，不做任何共享中间结果
    expect(request_a?.system_prompt).not.toBe(request_b?.system_prompt);
    expect(request_a?.response_schema).toEqual(request_b?.response_schema);
    expect(request_a?.system_prompt).toContain("盲评");
  });

  it("temperature=0、prompt_hash/response_hash 可复算、usage 与 request_id 逐票落账", async () => {
    const a = new MockProvider({
      provider: "provider-a",
      by_model_id: {
        [MODEL_A]: [
          voteReply("选项A", [anchor("src/a.ts#A")], "理由", 0.8),
        ],
      },
    });
    const b = new MockProvider({
      by_model_id: {
        [MODEL_B]: [mockReply({ conclusion: "选项A", anchors: [anchor("src/b.ts#B")], confidence: 0.6, reason: "理由" }, { usage: { input_tokens: 1200, output_tokens: 80 }, request_id: "req-b-1", latency_ms: 42 })],
      },
    });

    const record = await createVoteExecutor({ rng: mulberry32(16) }).run(makeInput({ voters: twoVoters(a, b) }));

    const request_a = a.requests[0];
    expect(request_a?.temperature).toBe(0);
    expect(request_a?.model_id).toBe(MODEL_A);
    expect(record.ballots[0]?.prompt_hash).toBe(hashPrompt(request_a?.system_prompt ?? "", request_a?.user_prompt ?? ""));
    expect(record.ballots[0]?.response_hash).toBe(
      createHash("sha256").update(JSON.stringify({ conclusion: "选项A", anchors: [anchor("src/a.ts#A")], confidence: 0.8, reason: "理由" }), "utf8").digest("hex"),
    );
    expect(record.ballots[1]?.usage).toEqual({ input_tokens: 1200, output_tokens: 80 });
    expect(record.ballots[1]?.request_id).toBe("req-b-1");
    expect(record.ballots[0]?.confidence).toBe(0.8);
    expect(record.ballots[1]?.confidence).toBe(0.6);
  });

  it("选项随机置换被记录，且 prompt 中的选项顺序与置换一致", async () => {
    const a = new MockProvider({ by_model_id: { [MODEL_A]: [voteReply("选项A", [anchor("src/a.ts#A")])] } });
    const b = new MockProvider({ by_model_id: { [MODEL_B]: [voteReply("选项A", [anchor("src/b.ts#B")])] } });
    const options = ["选项A", "选项B", "选项C"];
    const canonical = canonicalOptions(options);

    const record = await createVoteExecutor({ rng: mulberry32(17) }).run(makeInput({ voters: twoVoters(a, b), options }));

    for (const [index, ballot] of record.ballots.entries()) {
      expect([...ballot.option_permutation].sort((x, y) => x - y)).toEqual([0, 1, 2, 3]);
      const request = (index === 0 ? a : b).requests[0];
      const prompt = request?.system_prompt ?? "";
      const shown = ballot.option_permutation.map((canonical_index) => canonical[canonical_index]);
      expect(prompt).toContain(shown.map((option) => `- ${option}`).join("\n"));
      expect(prompt).toContain(buildSystemPrompt(canonical, ballot.option_permutation));
    }
  });

  it("可注入 RNG：同 seed 复现同样的置换与 prompt_hash，不同 seed 则不同", async () => {
    const runOnce = async (seed: number) => {
      const a = new MockProvider({ by_model_id: { [MODEL_A]: [voteReply("选项A", [anchor("src/a.ts#A")])] } });
      const b = new MockProvider({ by_model_id: { [MODEL_B]: [voteReply("选项A", [anchor("src/b.ts#B")])] } });
      const record = await createVoteExecutor({ rng: mulberry32(seed) }).run(
        makeInput({ voters: twoVoters(a, b), options: ["选项A", "选项B", "选项C"] }),
      );
      return {
        permutations: record.ballots.map((ballot) => ballot.option_permutation),
        hashes: record.ballots.map((ballot) => ballot.prompt_hash),
        prompts: a.requests.map((request) => request.system_prompt),
      };
    };

    const first = await runOnce(2026);
    const replay = await runOnce(2026);
    const other = await runOnce(7);

    expect(replay.permutations).toEqual(first.permutations);
    expect(replay.hashes).toEqual(first.hashes);
    expect(replay.prompts).toEqual(first.prompts);
    expect(other.hashes).not.toEqual(first.hashes);
  });

  it("逐票审计回调给出 ballot 里没有位置的字段（served_model_id / latency / 被剔除锚点）", async () => {
    const audits: BallotAudit[] = [];
    const a = new MockProvider({
      provider: "provider-a",
      by_model_id: {
        [MODEL_A]: [voteReply("选项A", [anchor("src/ghost.ts#Nope")], "理由原文")],
      },
    });
    const b = new MockProvider({
      by_model_id: {
        [MODEL_B]: [mockReply({ conclusion: "选项A", anchors: [anchor("src/b.ts#B")], confidence: 0.5, reason: "r" }, { served_model_id: `${MODEL_B}-resolved`, latency_ms: 123 })],
      },
    });

    const record = await createVoteExecutor({
      rng: mulberry32(18),
      on_ballot_audit: (audit) => audits.push(audit),
    }).run(
      makeInput({ voters: twoVoters(a, b), verify_anchor: verifyOnly(["src/b.ts#B"]) }),
    );

    expect(audits).toHaveLength(2);
    expect(audits[0]?.dropped_anchors.map((a_) => a_.anchor)).toEqual(["src/ghost.ts#Nope"]);
    expect(audits[1]?.served_model_id).toBe(`${MODEL_B}-resolved`);
    expect(audits[1]?.latency_ms).toBe(123);
    // Ballot.model_id 记录服务端实际解析到的版本（不得静默降级后与记录不符）
    expect(record.ballots[1]?.model_id).toBe(`${MODEL_B}-resolved`);
    expect(audits[0]?.requested_model_id).toBe(MODEL_A);
  });

  it("vote_id 可显式注入，缺省按实例内序号生成", async () => {
    const a = new MockProvider({ fallback: voteReply("选项A", [anchor("src/a.ts#A")]) });
    const explicit = createVoteExecutor({ rng: mulberry32(19), vote_id: "V-0007" });
    const first = await explicit.run(makeInput({ voters: twoVoters(a, a) }));
    expect(first.vote_id).toBe("V-0007");
    expect(first.k).toBe(2);

    const generated = createVoteExecutor({ rng: mulberry32(20) });
    const record_one = await generated.run(makeInput({ voters: twoVoters(a, a) }));
    const record_two = await generated.run(makeInput({ voters: twoVoters(a, a) }));
    expect([record_one.vote_id, record_two.vote_id]).toEqual(["V-1", "V-2"]);
  });
});

describe("canonicalOptions / buildSystemPrompt", () => {
  it("补齐固定兜底项，已含则不重复追加", () => {
    expect(canonicalOptions(["A", "B"])).toEqual(["A", "B", ABSTAIN_OPTION]);
    expect(canonicalOptions(["A", ABSTAIN_OPTION])).toEqual(["A", ABSTAIN_OPTION]);
  });

  it("system prompt 含盲评纪律、兜底项语义与结构化输出契约", () => {
    const prompt = buildSystemPrompt(["A", "B", ABSTAIN_OPTION], [1, 0, 2]);
    expect(prompt).toContain("盲评纪律");
    expect(prompt).toContain("- B\n- A\n- insufficient_evidence");
    expect(prompt).toContain("不许强行二选一");
    expect(prompt).toContain('"conclusion"');
    expect(prompt).toContain('"anchors"');
  });
});
