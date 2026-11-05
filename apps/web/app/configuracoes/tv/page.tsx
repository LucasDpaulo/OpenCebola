import type { Metadata } from "next";
import { TvInstallGuide } from "./tv-install-guide";

export const metadata: Metadata = {
  title: "Instalar em uma TV · Cebola",
  description: "Instale e conecte o Cebola em uma TV Samsung ou Roku."
};

export default function TvInstallPage() { return <TvInstallGuide />; }
