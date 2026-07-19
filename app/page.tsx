import { HomeClient } from "@/components/HomeClient";

// Otherwise Next.js prerenders this page once at build time and bakes in
// stale data — matching the snapshot route's own `force-dynamic`
// (app/api/txline/snapshot/route.ts) so live data is always fetched fresh.
export const dynamic = "force-dynamic";

export default function Home() {
  return <HomeClient />;
}
