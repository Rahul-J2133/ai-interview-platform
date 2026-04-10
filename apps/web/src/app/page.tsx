import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import Link from "next/link";

export default async function Home() {
  const { userId } = await auth();
  if (userId) redirect("/dashboard");

  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-4 text-center">
      <div className="text-5xl mb-4">🎯</div>
      <h1 className="text-3xl font-bold mb-2">AI Interview Platform</h1>
      <p className="text-gray-400 mb-8 max-w-md">
        Practice system design, behavioral, and domain knowledge interviews
        with AI — get instant, personalised feedback.
      </p>
      <div className="flex gap-3">
        <Link
          href="/sign-up"
          className="bg-indigo-600 hover:bg-indigo-500 text-white px-6 py-2.5 rounded-lg font-medium transition-colors"
        >
          Get started
        </Link>
        <Link
          href="/sign-in"
          className="bg-gray-800 hover:bg-gray-700 text-white px-6 py-2.5 rounded-lg font-medium transition-colors"
        >
          Sign in
        </Link>
      </div>
    </main>
  );
}
