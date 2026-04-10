import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import ReportView from "./ReportView";

export default async function ReportPage({ params }: { params: { id: string } }) {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");
  return <ReportView sessionId={params.id} />;
}
