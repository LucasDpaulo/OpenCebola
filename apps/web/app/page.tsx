import { Suspense } from "react";
import { HomeExperience } from "./home-experience";

export default function HomePage() {
  return <Suspense fallback={null}><HomeExperience /></Suspense>;
}
