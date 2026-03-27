export function appendUrlPath(baseUrl: string, path: string): URL {
  const url = new URL(baseUrl);
  const normalizedBasePath = url.pathname.endsWith("/")
    ? url.pathname
    : `${url.pathname}/`;
  const normalizedPath = path.startsWith("/") ? path.slice(1) : path;

  url.pathname = `${normalizedBasePath}${normalizedPath}`;

  return url;
}
