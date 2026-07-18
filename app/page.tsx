import { HomeClient } from "@/components/HomeClient";
import { getConfiguredDataSource } from "@/lib/dataSource";

// Otherwise Next.js prerenders this page once at build time and bakes in
// whatever TXLINE_DATA_SOURCE was set then — matching the snapshot route's
// own `force-dynamic` (app/api/txline/snapshot/route.ts) so a runtime env
// change (no rebuild) is reflected on next request, not stuck on stale HTML.
export const dynamic = "force-dynamic";

export default function Home() {
  const dataSource = getConfiguredDataSource();
  return <HomeClient dataSource={dataSource} />;
}
