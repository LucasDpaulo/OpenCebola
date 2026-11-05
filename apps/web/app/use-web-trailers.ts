"use client";
import { useEffect, useState } from "react";
import { isNativeRuntime } from "./api-client";

/** Trailers ficam disponíveis somente no navegador, fora do modo TV. */
export function webTrailersAllowed(native: boolean, tv: boolean): boolean {
  return !native && !tv;
}

export function useWebTrailers(tv: boolean): boolean {
  const [allowed, setAllowed] = useState(false);
  useEffect(() => { setAllowed(webTrailersAllowed(isNativeRuntime(), tv)); }, [tv]);
  return allowed && !tv;
}
