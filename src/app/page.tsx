import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth";

export default async function RootPage() {
  const ctx = await getAuthContext();
  redirect(ctx ? "/dashboard.html" : "/login");
}
