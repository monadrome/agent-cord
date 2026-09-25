import { describe, expect, it } from "vitest";

import { ABSTAIN_OPTION, MockProvider, anchorOverlap, createVoteExecutor, mockReply } from "../../src/voting/index.js";
import { anchor, makeInput, mulberry32, voteReply } from "./helpers.js";

/** 公开入口（src/voting/index.ts）的接线自检：一次完整投票走到 confirmed。 */
describe("voting 公开入口", () => {
  it("通过 barrel 导出即可完成一次盲评投票并返回合规 VoteRecord", async () => {
    expect(ABSTAIN_OPTION).toBe("insufficient_evidence");
    expect(anchorOverlap([anchor("src/a.ts#A")], [anchor("src/a.ts#A")])).toEqual({ jaccard: 1, subset: true });

    const a = new MockProvider({
      provider: "provider-a",
      by_model_id: { "model-a-2026-01-01": [voteReply("选项A", [anchor("src/a.ts#A")])] },
    });
    const b = new MockProvider({
      provider: "provider-b",
      fallback: mockReply({ conclusion: "选项A", anchors: [anchor("src/b.ts#B")], confidence: 0.5, reason: "r" }),
    });

    const record = await createVoteExecutor({ rng: mulberry32(99) }).run(
      makeInput({
        voters: [
          { agent_id: "reviewer-a", adapter: a, model_id: "model-a-2026-01-01" },
          { agent_id: "reviewer-b", adapter: b, model_id: "model-b-2026-01-01" },
        ],
      }),
    );

    expect(record.verdict).toBe("confirmed");
    expect(record.ballots).toHaveLength(2);
    expect(record.stats).toEqual({ raw_agreement: 1, anchor_overlap: 0 });
  });

  it("薄编排层（CLI demo）的调用形态可用：MockProvider({provider, responses}) + 无 reason 的判定响应", async () => {
    const anchors = [
      { kind: "code" as const, anchor: "src/demo/target.ts#resolveDemoTarget", line_hint: "src/demo/target.ts:7" },
    ];
    const record = await createVoteExecutor().run(
      makeInput({
        voters: [
          {
            agent_id: "voter-a",
            model_id: "mock-a-v1",
            adapter: new MockProvider({
              provider: "mock-a",
              responses: [{ parsed_json: { conclusion: "选项A", anchors, confidence: 0.9 } }],
            }),
          },
          {
            agent_id: "voter-b",
            model_id: "mock-b-v1",
            adapter: new MockProvider({
              provider: "mock-b",
              responses: [
                {
                  parsed_json: {
                    conclusion: "选项A",
                    anchors: [{ kind: "doc", anchor: "docs/demo-acceptance.md#demo-acceptance" }],
                    confidence: 0.85,
                  },
                },
              ],
            }),
          },
        ],
      }),
    );

    expect(record.verdict).toBe("confirmed");
    expect(record.ballots.map((ballot) => ballot.conclusion)).toEqual(["选项A", "选项A"]);
  });
});
