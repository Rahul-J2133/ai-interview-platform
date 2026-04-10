"use client";
import { useAuth } from "@clerk/nextjs";
import { useCallback } from "react";

/**
 * Returns a stable getToken() function.
 * Throws if called when not authenticated.
 */
export function useToken() {
  const { getToken, isSignedIn } = useAuth();

  return useCallback(async (): Promise<string> => {
    if (!isSignedIn) throw new Error("Not signed in");
    const t = await getToken();
    if (!t) throw new Error("Could not get token");
    return t;
  }, [getToken, isSignedIn]);
}
