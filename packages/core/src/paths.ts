/** Match only declared route syntax before Elysia parses a protected body. */
export function routePattern(prefix: string, path: string): RegExp {
  const full = `${prefix === "/" ? "" : prefix}${path}`;
  const segments = full.split("/").map((segment) => {
    if (/^:[A-Za-z_]\w*$/.test(segment)) return "[^/]+";
    if (segment && !/^[-A-Za-z0-9._~%]+$/.test(segment))
      throw new Error(`Unsupported route segment '${segment}' in '${full}'.`);
    return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  return new RegExp(`^${segments.join("/").replace(/\/$/, "")}/?$`);
}

/**
 * Elysia locates the routed path with `url.indexOf("/", 11)`, assuming a host long enough to
 * push the path past that offset. A shorter host makes it route a suffix of the real path while
 * authentication matches the full URL pathname, so both must start at the same index.
 */
export function routerSeesUrlPath(url: string): boolean {
  return url.indexOf("/", 11) === url.indexOf("/", url.indexOf("://") + 3);
}

export function overlappingPaths(left: string, right: string): boolean {
  const first = left.replace(/\/$/, "").split("/");
  const second = right.replace(/\/$/, "").split("/");
  return (
    first.length === second.length &&
    first.every((segment, index) => {
      const other = second[index]!;
      return (
        segment.startsWith(":") ||
        other.startsWith(":") ||
        segment.toLowerCase() === other.toLowerCase()
      );
    })
  );
}
