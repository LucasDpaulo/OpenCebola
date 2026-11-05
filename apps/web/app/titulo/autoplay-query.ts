/** Remove o pedido de autoplay depois que a pessoa encerra o player. */
export function consumedAutoplayUrl(href: string): string | null {
  const url = new URL(href);
  if (url.searchParams.get("play") !== "1") return null;
  url.searchParams.delete("play");
  return `${url.pathname}${url.search}${url.hash}`;
}
