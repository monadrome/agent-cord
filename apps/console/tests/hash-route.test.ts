/**
 * hash 路由解析测试（react-router 未安装，路由是手写纯函数）：
 * 覆盖默认页、列表、详情（tab 子视图两种写法）与未知路径回落。
 */
import { describe, expect, it } from "vitest";
import { parseHash } from "../src/App.js";

describe("parseHash", () => {
  it("空 hash / 未知路径回落工作台", () => {
    expect(parseHash("")).toEqual({ page: "dashboard" });
    expect(parseHash("#/")).toEqual({ page: "dashboard" });
    expect(parseHash("#/nope")).toEqual({ page: "dashboard" });
  });

  it("需求列表与 SDLC 页面", () => {
    expect(parseHash("#/requirements")).toEqual({ page: "requirements" });
    expect(parseHash("#/sdlcs")).toEqual({ page: "sdlcs" });
  });

  it("需求详情默认概览 tab；支持路径段与 ?tab= 两种写法", () => {
    expect(parseHash("#/requirements/REQ-1")).toEqual({ page: "requirement", reqId: "REQ-1", tab: "overview" });
    expect(parseHash("#/requirements/REQ-1/ledger")).toEqual({ page: "requirement", reqId: "REQ-1", tab: "ledger" });
    expect(parseHash("#/requirements/REQ-1?tab=events")).toEqual({ page: "requirement", reqId: "REQ-1", tab: "events" });
    expect(parseHash("#/requirements/REQ-1/bogus")).toEqual({ page: "requirement", reqId: "REQ-1", tab: "overview" });
  });

  it("req_id 需解码（含 URL 编码字符）", () => {
    expect(parseHash("#/requirements/REQ%2F1/votes")).toEqual({ page: "requirement", reqId: "REQ/1", tab: "votes" });
  });
});
