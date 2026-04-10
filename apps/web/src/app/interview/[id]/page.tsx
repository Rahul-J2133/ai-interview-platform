import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import InterviewRoom from "./InterviewRoom";

export default async function InterviewPage({ params }: { params: { id: string } }) {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");
  return <InterviewRoom sessionId={params.id} />;
}
