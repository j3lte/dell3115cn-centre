import { useEffect, useState } from "react";
import { hashParts } from "../lib/router";

export function useHashParts(): string[] {
  const [parts, setParts] = useState(hashParts);
  useEffect(() => {
    const on = () => setParts(hashParts());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return parts;
}
