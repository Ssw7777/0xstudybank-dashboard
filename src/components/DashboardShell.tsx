"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Dashboard, type DashboardSection } from "./Dashboard";

const PATH_TO_SECTION: Record<string, DashboardSection> = {
  "/dashboard": "overview",
  "/dashboard/overview": "overview",
  "/dashboard/flows": "overview", // 流水已并入总览
  "/dashboard/tokens": "tokens",
  "/dashboard/defi": "defi",
  "/dashboard/exchanges": "exchanges",
  "/dashboard/changes": "exchanges", // 旧变动页并入交易所
  "/dashboard/manual": "manual",
  "/dashboard/addresses": "addresses",
};

function sectionFromPath(pathname: string | null): DashboardSection {
  if (!pathname) return "overview";
  return PATH_TO_SECTION[pathname] ?? "overview";
}

/**
 * 挂在 dashboard layout：跨 /dashboard/* 软切换时保持同一 Dashboard 实例，
 * 避免每次卸挂重装大表/图表并重拉全量 portfolio。
 */
export function DashboardShell() {
  const pathname = usePathname();
  const router = useRouter();
  const [section, setSection] = useState<DashboardSection>(() => sectionFromPath(pathname));

  useEffect(() => {
    setSection(sectionFromPath(pathname));
  }, [pathname]);

  const onNavigate = useCallback(
    (next: DashboardSection, href: string) => {
      setSection(next);
      if (pathname !== href) router.push(href);
    },
    [pathname, router]
  );

  return <Dashboard section={section} onNavigate={onNavigate} />;
}
