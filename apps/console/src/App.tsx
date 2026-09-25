/**
 * 控制台外壳与 hash 路由（react-router 未安装，用 hash 手写）：
 * `#/` 工作台、`#/requirements` 需求列表、`#/requirements/:id[/:tab|?tab=]` 需求详情、`#/sdlcs` SDLC。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import { Dashboard } from "./pages/Dashboard.js";
import { Requirements } from "./pages/Requirements.js";
import { DETAIL_TABS, RequirementDetail, type DetailTab } from "./pages/RequirementDetail.js";
import { Sdlcs } from "./pages/Sdlcs.js";

type Route =
  | { page: "dashboard" }
  | { page: "requirements" }
  | { page: "requirement"; reqId: string; tab: DetailTab }
  | { page: "sdlcs" };

function isTab(value: string | null | undefined): value is DetailTab {
  return value !== null && value !== undefined && (DETAIL_TABS as readonly string[]).includes(value);
}

/** 解析 location.hash；无法识别一律回落到工作台 */
export function parseHash(hash: string): Route {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const queryIndex = raw.indexOf("?");
  const path = queryIndex === -1 ? raw : raw.slice(0, queryIndex);
  const query = new URLSearchParams(queryIndex === -1 ? "" : raw.slice(queryIndex + 1));
  const segments = path.split("/").filter((segment) => segment !== "");
  const [first, second, third] = segments;

  if (first === undefined) return { page: "dashboard" };
  if (first === "requirements") {
    if (second === undefined) return { page: "requirements" };
    const tabParam = third ?? query.get("tab");
    return { page: "requirement", reqId: decodeURIComponent(second), tab: isTab(tabParam) ? tabParam : "overview" };
  }
  if (first === "sdlcs") return { page: "sdlcs" };
  return { page: "dashboard" };
}

const NAV: readonly { href: string; label: string; page: Route["page"] }[] = [
  { href: "#/", label: "工作台", page: "dashboard" },
  { href: "#/requirements", label: "需求", page: "requirements" },
  { href: "#/sdlcs", label: "SDLC", page: "sdlcs" },
];

export function App(): ReactElement {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onHashChange = (): void => setHash(window.location.hash);
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const route = useMemo(() => parseHash(hash), [hash]);
  const navigate = useCallback((next: string): void => {
    window.location.hash = next;
  }, []);

  return (
    <div className="shell">
      <header className="topbar">
        <a className="brand" href="#/">
          agent<span>-cord</span> 控制台
        </a>
        <nav className="topnav" aria-label="主导航">
          {NAV.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className={route.page === item.page || (item.page === "requirements" && route.page === "requirement") ? "nav-link nav-active" : "nav-link"}
            >
              {item.label}
            </a>
          ))}
        </nav>
      </header>
      <main className="content">
        {route.page === "dashboard" ? (
          <Dashboard onOpenRequirement={(reqId) => navigate(`#/requirements/${encodeURIComponent(reqId)}`)} />
        ) : null}
        {route.page === "requirements" ? (
          <Requirements onOpenRequirement={(reqId) => navigate(`#/requirements/${encodeURIComponent(reqId)}`)} />
        ) : null}
        {route.page === "requirement" ? (
          <RequirementDetail
            key={route.reqId}
            reqId={route.reqId}
            tab={route.tab}
            onTab={(tab) => navigate(`#/requirements/${encodeURIComponent(route.reqId)}/${tab}`)}
            onBack={() => navigate("#/requirements")}
          />
        ) : null}
        {route.page === "sdlcs" ? <Sdlcs /> : null}
      </main>
    </div>
  );
}
