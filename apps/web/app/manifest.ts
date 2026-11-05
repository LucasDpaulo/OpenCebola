import type { MetadataRoute } from "next";

export const dynamic = "force-static";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "OpenCebola",
    short_name: "OpenCebola",
    description: "Sua casa de filmes e séries.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#16181d",
    theme_color: "#16181d",
    lang: "pt-BR",
    categories: ["entertainment", "video"],
    icons: [
      { src: "/icons/cebola-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icons/cebola-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
    ]
  };
}
